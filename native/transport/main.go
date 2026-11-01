// The helper owns transport only. All workflow and payment decisions live in TypeScript.
package main

import (
	"bufio"
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
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Profile string            `json:"profile"`
	Proxy   string            `json:"proxyUrl"`
	Cookies []Cookie          `json:"cookies"`
}

var profileMap = map[string]profiles.ClientProfile{"chrome_146": profiles.Chrome_146, "chrome_133": profiles.Chrome_133, "chrome_131": profiles.Chrome_131, "chrome_124": profiles.Chrome_124, "chrome_120": profiles.Chrome_120}
var hosts = map[string]bool{"chatgpt.com": true, "auth.openai.com": true, "api.stripe.com": true, "m.stripe.com": true, "r.stripe.com": true, "sentinel.openai.com": true, "ipapi.co": true}

// Classify locally; never return raw errors containing proxy credentials or URLs.
func transportErrorCode(err error) string {
	detail := strings.ToLower(err.Error())
	switch {
	case strings.Contains(detail, "proxy responded with non 200 code: 403"):
		return "PROXY_FORBIDDEN"
	case strings.Contains(detail, "proxy responded with non 200 code: 407"), strings.Contains(detail, "username/password authentication failed"), strings.Contains(detail, "no acceptable authentication methods"):
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
	default:
		return "UPSTREAM_TRANSPORT_FAILED"
	}
}

func main() {
	var client tls.HttpClient
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
			profile, ok := profileMap[input.Profile]
			if !ok {
				send(map[string]any{"id": input.ID, "error": "unsupported TLS profile"})
				continue
			}
			opts := []tls.HttpClientOption{tls.WithTimeoutSeconds(35), tls.WithClientProfile(profile), tls.WithCookieJar(tls.NewCookieJar()), tls.WithNotFollowRedirects()}
			if input.Proxy != "" {
				opts = append(opts, tls.WithProxyUrl(input.Proxy))
			}
			var err error
			client, err = tls.NewHttpClient(tls.NewNoopLogger(), opts...)
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
		u, err := url.Parse(input.URL)
		if err != nil || u.Scheme != "https" || !hosts[u.Hostname()] || u.User != nil || (u.Port() != "" && u.Port() != "443") {
			send(map[string]any{"id": input.ID, "error": "target not permitted"})
			continue
		}
		if input.Method != "GET" && input.Method != "POST" {
			send(map[string]any{"id": input.ID, "error": "method not permitted"})
			continue
		}
		request, err := http.NewRequest(input.Method, input.URL, strings.NewReader(input.Body))
		if err != nil {
			send(map[string]any{"id": input.ID, "error": "request invalid"})
			continue
		}
		for k, v := range input.Headers {
			request.Header.Set(k, v)
		}
		response, err := client.Do(request)
		if err != nil {
			send(map[string]any{"id": input.ID, "error": "upstream transport failed", "code": transportErrorCode(err)})
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
		response.Body.Close()
		if readErr != nil || len(body) > 8*1024*1024 {
			code := "UPSTREAM_READ_FAILED"
			if len(body) > 8*1024*1024 {
				code = "UPSTREAM_RESPONSE_TOO_LARGE"
				body = body[:8*1024*1024]
			}
			send(map[string]any{"id": input.ID, "error": "response read failed", "code": code, "status": response.StatusCode, "headers": response.Header, "body": string(body), "partial": true})
			continue
		}
		domains[u.Hostname()] = true
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
		send(map[string]any{"id": input.ID, "status": response.StatusCode, "headers": response.Header, "body": string(body), "cookies": cookies})
	}
}
