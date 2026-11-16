package main

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	http "github.com/bogdanfinn/fhttp"
	"github.com/bogdanfinn/fhttp/httptrace"
	tls "github.com/bogdanfinn/tls-client"
	utls "github.com/bogdanfinn/utls"
	"golang.org/x/net/proxy"
)

// Diagnostics deliberately contain no addresses, arbitrary error strings,
// headers or request data. The parent process applies its own allowlist too.
type TransportDiagnostic struct {
	Phase              string `json:"phase"`
	Reason             string `json:"reason,omitempty"`
	ElapsedMs          int64  `json:"elapsedMs"`
	ProxyConnectStatus int    `json:"proxyConnectStatus,omitempty"`
	DialCompleted      bool   `json:"dialCompleted"`
	RequestWritten     bool   `json:"requestWritten"`
	ResponseStarted    bool   `json:"responseStarted"`
	ConnectionReused   bool   `json:"connectionReused,omitempty"`
}

type requestDiagnostic struct {
	mu                    sync.Mutex
	started               time.Time
	value                 TransportDiagnostic
	dialing               int
	targetConnectionReady bool
}

func (d *requestDiagnostic) targetUpdate(update func(*TransportDiagnostic)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	// The library carries the same context into its CONNECT request. Its
	// header/write callbacks are proxy negotiation, not the target request.
	if d.dialing == 0 && d.targetConnectionReady {
		update(&d.value)
	}
}

func (d *requestDiagnostic) update(update func(*TransportDiagnostic)) {
	d.mu.Lock()
	defer d.mu.Unlock()
	update(&d.value)
}

func (d *requestDiagnostic) attach(request *http.Request) *http.Request {
	trace := &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			d.update(func(v *TransportDiagnostic) {
				if d.dialing != 0 {
					return
				}
				d.targetConnectionReady = true
				v.Phase = "request_write"
				v.ConnectionReused = info.Reused
			})
		},
		// A write callback means some bytes may already have left the client;
		// even a failed WroteRequest is not proof that replaying a POST is safe.
		WroteHeaderField: func(string, []string) {
			d.targetUpdate(func(v *TransportDiagnostic) { v.RequestWritten = true })
		},
		WroteHeaders: func() {
			d.targetUpdate(func(v *TransportDiagnostic) { v.RequestWritten = true })
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {
			d.targetUpdate(func(v *TransportDiagnostic) {
				v.RequestWritten = true
				v.Phase = "response_headers"
			})
		},
		GotFirstResponseByte: func() {
			d.targetUpdate(func(v *TransportDiagnostic) {
				v.ResponseStarted = true
				v.Phase = "response_headers"
			})
		},
	}
	return request.WithContext(httptrace.WithClientTrace(request.Context(), trace))
}

func (d *requestDiagnostic) finish(err error) TransportDiagnostic {
	d.mu.Lock()
	defer d.mu.Unlock()
	value := d.value
	value.ElapsedMs = time.Since(d.started).Milliseconds()
	if err == nil {
		value.Phase = "complete"
		return value
	}
	value.Reason = transportErrorReason(err)
	if status := proxyConnectStatus(err); status != 0 {
		value.Phase = "proxy_connect"
		value.ProxyConnectStatus = status
	}
	return value
}

type transportObserver struct {
	mu          sync.Mutex
	current     *requestDiagnostic
	proxyScheme string
}

func (o *transportObserver) start() *requestDiagnostic {
	d := &requestDiagnostic{started: time.Now(), value: TransportDiagnostic{Phase: "connect"}}
	o.mu.Lock()
	o.current = d
	o.mu.Unlock()
	return d
}

func (o *transportObserver) active() *requestDiagnostic {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.current
}

// The library performs its first uTLS handshake before constructing fhttp's
// transport, so the normal TLSHandshakeStart hook does not cover that failure.
// Wrap the library's existing dialer instead of reimplementing proxy protocols.
type observedDialer struct {
	inner    proxy.ContextDialer
	observer *transportObserver
}

func (d *observedDialer) Dial(network, address string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, address)
}

func (d *observedDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	state := d.observer.active()
	if state != nil {
		state.update(func(*TransportDiagnostic) { state.dialing++ })
	}
	connection, err := d.inner.DialContext(ctx, network, address)
	if state != nil {
		state.update(func(v *TransportDiagnostic) {
			state.dialing--
			if err != nil {
				return
			}
			v.DialCompleted = true
			v.Phase = "tls_handshake"
			if d.observer.proxyScheme == "http" || d.observer.proxyScheme == "https" {
				// The unchanged library HTTP(S) dialer returns only after CONNECT 200.
				v.ProxyConnectStatus = 200
			}
		})
	}
	return connection, err
}

func newObservedClient(profileName, proxyURL string, extraOptions ...tls.HttpClientOption) (tls.HttpClient, *transportObserver, error) {
	profile, ok := profileMap[profileName]
	if !ok {
		return nil, nil, errors.New("unsupported TLS profile")
	}
	options := []tls.HttpClientOption{
		tls.WithTimeoutSeconds(35), tls.WithClientProfile(profile),
		tls.WithCookieJar(tls.NewCookieJar()), tls.WithNotFollowRedirects(),
	}
	options = append(options, extraOptions...)
	if proxyURL != "" {
		options = append(options, tls.WithProxyUrl(proxyURL))
	}
	// Constructing a client performs no network I/O. This obtains the exact
	// existing direct/HTTP/HTTPS/SOCKS dialer and its original security defaults.
	base, err := tls.NewHttpClient(tls.NewNoopLogger(), options...)
	if err != nil {
		return nil, nil, err
	}
	observer := &transportObserver{}
	if parsed, err := url.Parse(proxyURL); err == nil {
		observer.proxyScheme = parsed.Scheme
	}
	dialer := &observedDialer{inner: base.GetDialer(), observer: observer}
	options = append(options, tls.WithProxyUrl(""), tls.WithProxyDialerFactory(
		func(string, time.Duration, *net.TCPAddr, http.Header, tls.Logger) (proxy.ContextDialer, error) {
			return dialer, nil
		},
	))
	client, err := tls.NewHttpClient(tls.NewNoopLogger(), options...)
	return client, observer, err
}

var connectStatusPattern = regexp.MustCompile(`^Proxy responded with non 200 code: ([1-5][0-9]{2})(?:\s|$)`)

func proxyConnectStatus(err error) int {
	for current := err; current != nil; current = errors.Unwrap(current) {
		// Inspect only the library's fixed prefix, not numbers embedded in URLs
		// or arbitrary error text. Never include the matched text in diagnostics.
		match := connectStatusPattern.FindStringSubmatch(current.Error())
		if match != nil {
			status, _ := strconv.Atoi(match[1])
			if status != 200 {
				return status
			}
		}
	}
	return 0
}

func transportErrorReason(err error) string {
	if status := proxyConnectStatus(err); status != 0 {
		if status == 407 {
			return "proxy_auth"
		}
		return "proxy_status"
	}
	detail := strings.ToLower(err.Error())
	if strings.Contains(detail, "username/password authentication failed") || strings.Contains(detail, "no acceptable authentication methods") {
		return "proxy_auth"
	}
	if strings.Contains(detail, "unexpected protocol version") || strings.Contains(detail, "malformed http response") || strings.Contains(detail, "first record does not look like a tls handshake") {
		return "protocol"
	}
	var certificateInvalid x509.CertificateInvalidError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameError x509.HostnameError
	if errors.As(err, &certificateInvalid) || errors.As(err, &unknownAuthority) || errors.As(err, &hostnameError) || strings.Contains(detail, "x509:") {
		return "certificate"
	}
	var timeout net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &timeout) && timeout.Timeout()) {
		return "timeout"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "unexpected_eof"
	}
	if errors.Is(err, io.EOF) {
		return "connection_closed"
	}
	if strings.Contains(detail, "connection refused") {
		return "connection_refused"
	}
	if strings.Contains(detail, "connection reset") || strings.Contains(detail, "broken pipe") {
		return "connection_reset"
	}
	var alert utls.AlertError
	if errors.As(err, &alert) || strings.Contains(detail, "tls:") {
		return "tls_alert"
	}
	return "unknown"
}
