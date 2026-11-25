package main

import (
	"crypto/x509"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	fhttp "github.com/bogdanfinn/fhttp"
	tls "github.com/bogdanfinn/tls-client"
)

func TestSDKRequestBudgetStopsAnInitialTLSHandshake(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n")
		_, _ = io.Copy(io.Discard, connection)
	}))
	defer gateway.Close()
	client, observer, err := newObservedClient("chrome_146", gateway.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	result := performUpstreamRequest(
		Request{ID: "deadline", Method: "GET", URL: "https://api.stripe.com/relay-test", TimeoutMs: 200},
		"api.stripe.com", client, observer, map[string]bool{},
	)
	diagnostic := result["diagnostic"].(TransportDiagnostic)
	if result["code"] != "TRANSPORT_BUDGET_EXHAUSTED" || diagnostic.Phase != "tls_handshake" || diagnostic.Reason != "timeout" || diagnostic.ProxyConnectStatus != 200 || diagnostic.RequestWritten || diagnostic.ResponseStarted {
		t.Fatalf("expected a native budget error before writing to the target: %+v", result)
	}
}

func TestSDKRequestBudgetReturnsAnIncompleteResponse(t *testing.T) {
	for _, http2 := range []bool{false, true} {
		protocol := "http1"
		if http2 {
			protocol = "http2"
		}
		t.Run(protocol, func(t *testing.T) {
			var dispatched atomic.Int32
			target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					_, _ = io.WriteString(w, "ready")
					return
				}
				dispatched.Add(1)
				w.Header().Set("Request-Id", "req_localFixture")
				w.WriteHeader(http.StatusAccepted)
				_, _ = io.WriteString(w, "partial")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			target.EnableHTTP2 = http2
			target.StartTLS()
			defer target.Close()
			roots := x509.NewCertPool()
			roots.AddCert(target.Certificate())
			client, observer, err := newObservedClient("chrome_146", "", tls.WithTransportOptions(&tls.TransportOptions{RootCAs: roots}))
			if err != nil {
				t.Fatal(err)
			}
			defer client.CloseIdleConnections()
			domains := map[string]bool{}
			result := performUpstreamRequest(
				Request{ID: "deadline", Method: "POST", URL: target.URL, TimeoutMs: 250,
					Body: "{}", Headers: map[string]string{"idempotency-key": "loopback-test"}},
				"127.0.0.1", client, observer, domains,
			)
			diagnostic := result["diagnostic"].(TransportDiagnostic)
			if result["code"] != "TRANSPORT_BUDGET_EXHAUSTED" || result["status"] != http.StatusAccepted || result["partial"] != true || result["body"] != "partial" || diagnostic.Phase != "response_body" || diagnostic.Reason != "timeout" || !diagnostic.RequestWritten || !diagnostic.ResponseStarted {
				t.Fatalf("expected original incomplete response and timeout diagnostics: %+v", result)
			}
			next := performUpstreamRequest(Request{ID: "next", Method: "GET", URL: target.URL, TimeoutMs: 2000}, "127.0.0.1", client, observer, domains)
			if next["status"] != http.StatusOK || next["body"] != "ready" || dispatched.Load() != 1 {
				t.Fatalf("the same client should serve the next request without replaying the POST: %+v", next)
			}
		})
	}
}

func TestTransportErrorCode(t *testing.T) {
	cases := []struct {
		err  error
		code string
	}{
		{errors.New("Proxy responded with non 200 code: 403 Forbidden"), "PROXY_FORBIDDEN"},
		{errors.New("Proxy responded with non 200 code: 407 Proxy Authentication Required"), "PROXY_AUTH_REQUIRED"},
		{errors.New("socks connect: username/password authentication failed"), "PROXY_AUTH_REQUIRED"},
		{errors.New("socks connect: unexpected protocol version 72"), "PROXY_SOCKS_HTTP_RESPONSE"},
		{errors.New("socks connect: unexpected protocol version 4"), "PROXY_PROTOCOL_MISMATCH"},
		{&net.DNSError{Err: "no such host", Name: "private-host"}, "UPSTREAM_DNS_FAILED"},
		{&net.DNSError{IsTimeout: true}, "UPSTREAM_TIMEOUT"},
		{errors.New("x509: certificate has expired"), "UPSTREAM_TLS_FAILED"},
		{errors.New("dial tcp: connection refused"), "UPSTREAM_CONNECTION_FAILED"},
		{errors.New("http://private-user:private-password@private-host/"), "UPSTREAM_TRANSPORT_FAILED"},
	}
	for _, c := range cases {
		if code := transportErrorCode(c.err); code != c.code {
			t.Errorf("expected %s, got %s", c.code, code)
		}
	}
}

func TestSocksGatewayHTTPDenialBeforeAuthentication(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		greeting := make([]byte, 2)
		if _, err = io.ReadFull(conn, greeting); err != nil {
			done <- err
			return
		}
		methods := make([]byte, int(greeting[1]))
		if _, err = io.ReadFull(conn, methods); err != nil {
			done <- err
			return
		}
		if greeting[0] != 5 {
			done <- errors.New("expected SOCKS5 greeting")
			return
		}
		_, err = io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
		done <- err
	}()
	client, err := tls.NewHttpClient(tls.NewNoopLogger(), tls.WithProxyUrl("socks5://user:secret@"+listener.Addr().String()), tls.WithTimeoutSeconds(2))
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	_, err = client.Get("https://ipapi.co/json/")
	if err == nil {
		t.Fatal("expected SOCKS handshake failure")
	}
	if code := transportErrorCode(err); code != "PROXY_SOCKS_HTTP_RESPONSE" {
		t.Fatalf("unexpected diagnostic %s", code)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
}

func TestConnectDenialFromRealTransport(t *testing.T) {
	for _, status := range []int{403, 407} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "CONNECT" {
					t.Errorf("expected CONNECT, got %s", r.Method)
				}
				w.WriteHeader(status)
			}))
			defer gateway.Close()
			client, err := tls.NewHttpClient(tls.NewNoopLogger(), tls.WithProxyUrl(gateway.URL), tls.WithTimeoutSeconds(2))
			if err != nil {
				t.Fatal(err)
			}
			defer client.CloseIdleConnections()
			_, err = client.Get("https://ipapi.co/json/")
			if err == nil {
				t.Fatal("expected proxy denial")
			}
			want := "PROXY_FORBIDDEN"
			if status == 407 {
				want = "PROXY_AUTH_REQUIRED"
			}
			if code := transportErrorCode(err); code != want {
				t.Fatalf("expected %s, got %s", want, code)
			}
		})
	}
}

func TestHeaderOrderIsReplayedVerbatim(t *testing.T) {
	request, err := newUpstreamRequest(Request{
		ID:          "order",
		Method:      "POST",
		URL:         "https://api.stripe.com/v1/payment_intents/pi_fixture/confirm",
		Body:        "client_secret=cs_fixture",
		Headers:     map[string]string{"sec-ch-ua": `"Chromium";v="146"`, "User-Agent": "ua", "accept": "application/json"},
		HeaderOrder: []string{"SEC-CH-UA", "user-agent", "accept", "content-type"},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := request.Header[fhttp.HeaderOrderKey]
	want := []string{"sec-ch-ua", "user-agent", "accept", "content-type"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
}

func TestHeaderOrderIsOptional(t *testing.T) {
	request, err := newUpstreamRequest(Request{ID: "plain", Method: "GET", URL: "https://api.stripe.com/v1/payment_methods"})
	if err != nil {
		t.Fatal(err)
	}
	if order, ok := request.Header[fhttp.HeaderOrderKey]; ok {
		t.Fatalf("expected no ordering key, got %v", order)
	}
}
