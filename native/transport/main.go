// The helper owns transport only. All workflow and payment decisions live in TypeScript.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	http "github.com/bogdanfinn/fhttp"
	tls "github.com/bogdanfinn/tls-client"
	"github.com/bogdanfinn/tls-client/profiles"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type Cookie struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	Domain  string `json:"domain"`
	Path    string `json:"path"`
	Secure  bool   `json:"secure"`
	Expires int64  `json:"expires"`
}
type Request struct {
	ID        string            `json:"id"`
	Method    string            `json:"method"`
	URL       string            `json:"url"`
	Headers   map[string]string `json:"headers"`
	Body      string            `json:"body"`
	TimeoutMs int               `json:"timeoutMs"`
	Profile   string            `json:"profile"`
	Proxy     string            `json:"proxyUrl"`
	Cookies   []Cookie          `json:"cookies"`
}

const nativeRequestTimeoutSeconds = 35

var profileMap = map[string]profiles.ClientProfile{"chrome_146": profiles.Chrome_146, "chrome_133": profiles.Chrome_133, "chrome_131": profiles.Chrome_131, "chrome_124": profiles.Chrome_124, "chrome_120": profiles.Chrome_120}
var hosts = map[string]bool{"chatgpt.com": true, "auth.openai.com": true, "api.stripe.com": true, "m.stripe.com": true, "r.stripe.com": true, "sentinel.openai.com": true, "ipapi.co": true}

// Classify locally; never return raw errors containing proxy credentials or URLs.
func transportErrorCode(err error) string {
	detail := strings.ToLower(err.Error())
	if status := proxyConnectStatus(err); status != 0 {
		switch status {
		case 403:
			return "PROXY_FORBIDDEN"
		case 407:
			return "PROXY_AUTH_REQUIRED"
		default:
			return "PROXY_CONNECT_FAILED"
		}
	}
	switch {
	case strings.Contains(detail, "username/password authentication failed"), strings.Contains(detail, "no acceptable authentication methods"):
		return "PROXY_AUTH_REQUIRED"
	case strings.Contains(detail, "unexpected protocol version 72"):
		// 'H' can start an HTTP access-denied page before SOCKS authentication.
		// The SOCKS library only retains this first byte, not the HTTP status.
		return "PROXY_SOCKS_HTTP_RESPONSE"
	case strings.Contains(detail, "unexpected protocol version"), strings.Contains(detail, "malformed http response"), strings.Contains(detail, "first record does not look like a tls handshake"):
		return "PROXY_PROTOCOL_MISMATCH"
	}
	var dns *net.DNSError
	var network net.Error
	switch {
	case errors.As(err, &network) && network.Timeout():
		return "UPSTREAM_TIMEOUT"
	case errors.As(err, &dns):
		return "UPSTREAM_DNS_FAILED"
	case strings.Contains(detail, "tls:"), strings.Contains(detail, "x509:"):
		return "UPSTREAM_TLS_FAILED"
	case strings.Contains(detail, "connection refused"), strings.Contains(detail, "network is unreachable"), strings.Contains(detail, "connection reset"):
		return "UPSTREAM_CONNECTION_FAILED"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "UPSTREAM_CONNECTION_CLOSED"
	default:
		return "UPSTREAM_TRANSPORT_FAILED"
	}
}

func newUpstreamRequest(input Request) (*http.Request, error) {
	var body io.Reader = strings.NewReader(input.Body)
	if input.Method == "POST" {
		// NewRequest normally makes strings.Reader bodies replayable. A
		// payment's idempotency header must not enable library-level replay
		// after an ambiguous disconnect, even for an empty POST body. Empty
		// POSTs use an empty chunked stream in HTTP/1.1; nonempty lengths stay exact.
		body = io.NopCloser(strings.NewReader(input.Body))
	}
	request, err := http.NewRequest(input.Method, input.URL, body)
	if err != nil {
		return nil, err
	}
	if input.Method == "POST" {
		request.GetBody = nil
		if len(input.Body) > 0 {
			request.ContentLength = int64(len(input.Body))
		}
	}
	for k, v := range input.Headers {
		request.Header.Set(k, v)
	}
	return request, nil
}

func main() {
	var client tls.HttpClient
	var observer *transportObserver
	var domains = map[string]bool{}
	var mutex sync.Mutex
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 65536), 8*1024*1024)
	send := func(value any) {
		mutex.Lock()
		defer mutex.Unlock()
		encoded, _ := json.Marshal(value)
		fmt.Println(string(encoded))
	}
	for scanner.Scan() {
		var input Request
		if json.Unmarshal(scanner.Bytes(), &input) != nil {
			send(map[string]any{"error": "invalid transport message"})
			continue
		}
		if input.Method == "initialize" {
			_, ok := profileMap[input.Profile]
			if !ok {
				send(map[string]any{"id": input.ID, "error": "unsupported TLS profile"})
				continue
			}
			var err error
			client, observer, err = newObservedClient(input.Profile, input.Proxy)
			if err != nil {
				send(map[string]any{"id": input.ID, "error": "transport initialization failed"})
				continue
			}
			for _, c := range input.Cookies {
				domain := strings.TrimPrefix(c.Domain, ".")
				if !hosts[domain] {
					continue
				}
				u, _ := url.Parse("https://" + domain + "/")
				cookie := &http.Cookie{Name: c.Name, Value: c.Value, Domain: c.Domain, Path: c.Path, Secure: c.Secure}
				if cookie.Path == "" {
					cookie.Path = "/"
				}
				if c.Expires > 0 {
					cookie.Expires = time.Unix(c.Expires, 0)
				}
				client.SetCookies(u, []*http.Cookie{cookie})
				domains[domain] = true
			}
			send(map[string]any{"id": input.ID, "ready": true})
			continue
		}
		if client == nil {
			send(map[string]any{"id": input.ID, "error": "transport not initialized"})
			continue
		}
		if input.Method == "reset_connections" {
			client.CloseIdleConnections()
			send(map[string]any{"id": input.ID, "ready": true})
			continue
		}
		u, err := url.Parse(input.URL)
		if err != nil || u.Scheme != "https" || !hosts[u.Hostname()] || u.User != nil || (u.Port() != "" && u.Port() != "443") {
			send(map[string]any{"id": input.ID, "error": "target not permitted"})
			continue
		}
		if input.Method != "GET" && input.Method != "POST" {
			send(map[string]any{"id": input.ID, "error": "method not permitted"})
			continue
		}
		send(performUpstreamRequest(input, u.Hostname(), client, observer, domains))
	}
}

func performUpstreamRequest(input Request, hostname string, client tls.HttpClient, observer *transportObserver, domains map[string]bool) map[string]any {
	request, err := newUpstreamRequest(input)
	if err != nil {
		return map[string]any{"id": input.ID, "error": "request invalid"}
	}
	// Apply the SDK budget only when it gives the request an earlier deadline
	// than the client's existing timeout.
	if input.TimeoutMs > 0 && input.TimeoutMs < nativeRequestTimeoutSeconds*1000 {
		ctx, cancel := context.WithTimeout(request.Context(), time.Duration(input.TimeoutMs)*time.Millisecond)
		defer cancel()
		request = request.WithContext(ctx)
	}
	diagnostic := observer.start()
	request = diagnostic.attach(request)
	response, err := client.Do(request)
	if response != nil {
		diagnostic.update(func(v *TransportDiagnostic) {
			v.ResponseStarted = true
			v.RequestWritten = true
			v.Phase = "response_body"
		})
	}
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		code := transportErrorCode(err)
		detail := diagnostic.finish(err)
		if detail.Reason == "timeout" && errors.Is(request.Context().Err(), context.DeadlineExceeded) {
			code = "TRANSPORT_BUDGET_EXHAUSTED"
		}
		return map[string]any{"id": input.ID, "error": "upstream transport failed", "code": code, "diagnostic": detail}
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
	response.Body.Close()
	if readErr != nil || len(body) > 8*1024*1024 {
		code := "UPSTREAM_READ_FAILED"
		if len(body) > 8*1024*1024 {
			code = "UPSTREAM_RESPONSE_TOO_LARGE"
			body = body[:8*1024*1024]
			readErr = errors.New("response limit reached")
		}
		detail := diagnostic.finish(readErr)
		if detail.Reason == "timeout" && errors.Is(request.Context().Err(), context.DeadlineExceeded) {
			code = "TRANSPORT_BUDGET_EXHAUSTED"
		}
		return map[string]any{"id": input.ID, "error": "response read failed", "code": code, "status": response.StatusCode, "headers": response.Header, "body": string(body), "partial": true, "diagnostic": detail}
	}
	domains[hostname] = true
	cookies := []Cookie{}
	for domain := range domains {
		target, _ := url.Parse("https://" + domain + "/")
		for _, c := range client.GetCookies(target) {
			expires := int64(0)
			if !c.Expires.IsZero() {
				expires = c.Expires.Unix()
			}
			cookies = append(cookies, Cookie{c.Name, c.Value, domain, c.Path, c.Secure, expires})
		}
	}
	return map[string]any{"id": input.ID, "status": response.StatusCode, "headers": response.Header, "body": string(body), "cookies": cookies, "diagnostic": diagnostic.finish(nil)}
}
