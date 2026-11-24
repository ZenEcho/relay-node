package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	tls "github.com/bogdanfinn/tls-client"
)

func failedRequest(t *testing.T, proxyURL string, timeout time.Duration) (error, TransportDiagnostic) {
	t.Helper()
	client, observer, err := newObservedClient("chrome_146", proxyURL)
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	request, err := fhttp.NewRequest("GET", "https://ipapi.co/json/?private-query=secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(request.Context(), timeout)
	defer cancel()
	state := observer.start()
	_, err = client.Do(state.attach(request.WithContext(ctx)))
	if err == nil {
		t.Fatal("expected local gateway failure")
	}
	return err, state.finish(err)
}

func TestObservedProxyTLSClosure(t *testing.T) {
	var clientHelloObserved atomic.Bool
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n")
		var header [5]byte
		if _, err := io.ReadFull(connection, header[:]); err == nil && header[0] == 22 {
			clientHelloObserved.Store(true)
		}
		// Close immediately after receiving the TLS record header. No HTTP
		// request or login data has been transmitted through this tunnel.
	}))
	defer gateway.Close()
	proxyURL := strings.Replace(gateway.URL, "http://", "http://private-user:private-password@", 1)
	err, diagnostic := failedRequest(t, proxyURL, time.Second*2)
	if !clientHelloObserved.Load() || !diagnostic.DialCompleted || diagnostic.ProxyConnectStatus != 200 || diagnostic.Phase != "tls_handshake" {
		t.Fatalf("expected an observed CONNECT followed by TLS, got %+v", diagnostic)
	}
	if diagnostic.RequestWritten || diagnostic.ResponseStarted {
		t.Fatalf("TLS closure must precede the HTTP request: %+v", diagnostic)
	}
	if diagnostic.Reason != "connection_closed" && diagnostic.Reason != "unexpected_eof" && diagnostic.Reason != "connection_reset" {
		t.Fatalf("expected a bounded closure reason, got %+v", diagnostic)
	}
	if code := transportErrorCode(err); code != "UPSTREAM_CONNECTION_CLOSED" && code != "UPSTREAM_CONNECTION_FAILED" {
		t.Fatalf("unexpected transport code %s", code)
	}
	bytes, _ := json.Marshal(diagnostic)
	for _, secret := range []string{"private-user", "private-password", "private-query", "secret", "ipapi.co", "127.0.0.1"} {
		if strings.Contains(string(bytes), secret) {
			t.Fatalf("diagnostic leaked %s", secret)
		}
	}
}

func TestUnknownConnectEOFIsNotCalledTLS(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = connection.Close()
		}
	}))
	defer gateway.Close()
	_, diagnostic := failedRequest(t, gateway.URL, time.Second*2)
	if diagnostic.Phase != "connect" || diagnostic.ProxyConnectStatus != 0 || diagnostic.DialCompleted || diagnostic.RequestWritten || diagnostic.ResponseStarted {
		t.Fatalf("EOF before CONNECT completion must remain an uncompleted connection: %+v", diagnostic)
	}
}

func TestObservedProxyTLSTimeout(t *testing.T) {
	done := make(chan struct{})
	defer close(done)
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer connection.Close()
		_, _ = io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n")
		<-done
	}))
	defer gateway.Close()
	_, diagnostic := failedRequest(t, gateway.URL, 150*time.Millisecond)
	if diagnostic.Phase != "tls_handshake" || diagnostic.Reason != "timeout" || !diagnostic.DialCompleted || diagnostic.ProxyConnectStatus != 200 || diagnostic.RequestWritten {
		t.Fatalf("unexpected TLS wait diagnostic: %+v", diagnostic)
	}
	if diagnostic.ElapsedMs < 100 || diagnostic.ElapsedMs > 2000 {
		t.Fatalf("unexpected elapsed duration: %+v", diagnostic)
	}
}

func TestObservedConnectStatus(t *testing.T) {
	for _, status := range []int{403, 407, 429, 502, 503, 504} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(status)
			}))
			defer gateway.Close()
			err, diagnostic := failedRequest(t, gateway.URL, time.Second*2)
			if diagnostic.Phase != "proxy_connect" || diagnostic.ProxyConnectStatus != status || diagnostic.DialCompleted || diagnostic.RequestWritten || diagnostic.ResponseStarted {
				t.Fatalf("expected a strictly parsed CONNECT status: %+v", diagnostic)
			}
			if status != 403 && status != 407 && transportErrorCode(err) != "PROXY_CONNECT_FAILED" {
				t.Fatal("transient gateway statuses must retain their proxy boundary")
			}
		})
	}
}

func TestCertificateFailureIsNotTransientClosure(t *testing.T) {
	var requests atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer target.Close()
	client, observer, err := newObservedClient("chrome_146", "")
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	request, _ := fhttp.NewRequest("GET", target.URL, nil)
	state := observer.start()
	_, err = client.Do(state.attach(request))
	if err == nil {
		t.Fatal("expected untrusted test certificate to be rejected")
	}
	diagnostic := state.finish(err)
	if diagnostic.Reason != "certificate" || diagnostic.Phase != "tls_handshake" || diagnostic.RequestWritten || diagnostic.ResponseStarted || requests.Load() != 0 {
		t.Fatalf("unexpected certificate diagnostic: %+v", diagnostic)
	}
}

func TestHTTPSProxyCertificateVerificationRemainsEnabled(t *testing.T) {
	var proxyRequests atomic.Int32
	gateway := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxyRequests.Add(1) }))
	defer gateway.Close()
	_, diagnostic := failedRequest(t, gateway.URL, 2*time.Second)
	if diagnostic.Reason != "certificate" || diagnostic.ProxyConnectStatus != 0 || diagnostic.DialCompleted || diagnostic.RequestWritten || proxyRequests.Load() != 0 {
		t.Fatalf("HTTPS proxy must retain its certificate verification: %+v", diagnostic)
	}
}

func TestObservedSocksDialerPreservesHandshakeFailure(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		greeting := make([]byte, 2)
		if _, err = io.ReadFull(conn, greeting); err != nil {
			return
		}
		methods := make([]byte, int(greeting[1]))
		if _, err = io.ReadFull(conn, methods); err != nil {
			return
		}
		_, _ = io.WriteString(conn, "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
	}()
	err, diagnostic := failedRequest(t, "socks5://user:secret@"+listener.Addr().String(), 2*time.Second)
	if transportErrorCode(err) != "PROXY_SOCKS_HTTP_RESPONSE" || diagnostic.Reason != "protocol" || diagnostic.Phase != "connect" || diagnostic.DialCompleted || diagnostic.RequestWritten {
		t.Fatalf("unexpected SOCKS negotiation diagnostic: %+v", diagnostic)
	}
	<-done
}

func TestDiagnosticErrorAllowlist(t *testing.T) {
	for _, test := range []struct {
		err    error
		reason string
	}{
		{io.EOF, "connection_closed"},
		{io.ErrUnexpectedEOF, "unexpected_eof"},
		{errors.New("remote error: tls: handshake failure"), "tls_alert"},
		{errors.New("connection reset by peer: private-token"), "connection_reset"},
		{errors.New("x509: private-account.invalid certificate expired"), "certificate"},
		{errors.New("http://private-user:private-password@private-host/?secret=token"), "unknown"},
	} {
		if reason := transportErrorReason(test.err); reason != test.reason {
			t.Fatalf("expected %s, got %s", test.reason, reason)
		}
	}
	if proxyConnectStatus(errors.New("URL secret-Proxy responded with non 200 code: 503")) != 0 {
		t.Fatal("CONNECT status must not be scraped from arbitrary text")
	}
}

func TestObservedClientConstructionPreservesProtocols(t *testing.T) {
	for _, proxyURL := range []string{"", "http://user:secret@127.0.0.1:18080", "https://user:secret@127.0.0.1:18443", "socks5://user:secret@127.0.0.1:11080", "socks5h://user:secret@127.0.0.1:11080"} {
		client, _, err := newObservedClient("chrome_146", proxyURL)
		if err != nil {
			t.Fatal("existing supported protocol construction failed")
		}
		target, _ := fhttp.NewRequest("GET", "https://chatgpt.com/", nil)
		client.SetCookies(target.URL, []*fhttp.Cookie{{Name: "session", Value: "private-login"}})
		client.CloseIdleConnections()
		cookies := client.GetCookies(target.URL)
		if len(cookies) != 1 || cookies[0].Value != "private-login" {
			t.Fatal("resetting connections must preserve the original cookie jar")
		}
	}
}

func TestObservedClientDropsLoginFragmentsBeforeSessionRefresh(t *testing.T) {
	const sessionCookie = "__Secure-next-auth.session-token"
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("refresh") == "true" {
			for _, suffix := range []string{".0", ".1"} {
				if _, err := r.Cookie(sessionCookie + suffix); err != http.ErrNoCookie {
					t.Errorf("refresh sent deleted Session fragment %s", suffix)
				}
			}
			if cookie, err := r.Cookie(sessionCookie); err != nil || cookie.Value != "replacement" {
				t.Error("refresh did not send the replacement Session cookie")
			}
			if cookie, err := r.Cookie("oai-did"); err != nil || cookie.Value != "device" {
				t.Error("refresh did not preserve the device cookie")
			}
			return
		}
		http.SetCookie(w, &http.Cookie{Name: sessionCookie + ".0", Path: "/", MaxAge: -1, Secure: true})
		http.SetCookie(w, &http.Cookie{Name: sessionCookie + ".1", Path: "/", Expires: time.Unix(1, 0), Secure: true})
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "replacement", Path: "/", Secure: true})
	}))
	defer target.Close()
	roots := x509.NewCertPool()
	roots.AddCert(target.Certificate())
	client, _, err := newObservedClient("chrome_146", "", tls.WithTransportOptions(&tls.TransportOptions{RootCAs: roots}))
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	initial, err := fhttp.NewRequest("GET", target.URL+"/api/auth/session", nil)
	if err != nil {
		t.Fatal(err)
	}
	client.SetCookies(initial.URL, []*fhttp.Cookie{
		{Name: sessionCookie + ".0", Value: "old-first", Path: "/", Secure: true},
		{Name: sessionCookie + ".1", Value: "old-second", Path: "/", Secure: true},
		{Name: "oai-did", Value: "device", Path: "/", Secure: true},
	})
	response, err := client.Do(initial)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	refresh, err := fhttp.NewRequest("GET", initial.URL.String()+"?refresh=true", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = client.Do(refresh)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if cookies := client.GetCookies(initial.URL); len(cookies) != 2 {
		t.Fatalf("expected two active cookies in the snapshot, got %d", len(cookies))
	}
}

func TestObservedProxyHTTPAndHTTP2AndConnectionReset(t *testing.T) {
	for _, http2 := range []bool{false, true} {
		name := "http1"
		if http2 {
			name = "http2"
		}
		t.Run(name, func(t *testing.T) {
			var requests atomic.Int32
			target := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) > 1 {
					cookie, err := r.Cookie("session")
					if err != nil || cookie.Value != "private-login" {
						t.Error("cookie missing after connection reset")
					}
				}
				http.SetCookie(w, &http.Cookie{Name: "session", Value: "private-login", Path: "/"})
				_, _ = io.WriteString(w, "ok")
			}))
			target.EnableHTTP2 = http2
			target.StartTLS()
			defer target.Close()
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer connection.Close()
				upstream, err := net.Dial("tcp", target.Listener.Addr().String())
				if err != nil {
					return
				}
				defer upstream.Close()
				_, _ = io.WriteString(connection, "HTTP/1.1 200 Connection Established\r\n\r\n")
				go func() { _, _ = io.Copy(upstream, connection); _ = upstream.Close() }()
				_, _ = io.Copy(connection, upstream)
			}))
			defer gateway.Close()
			roots := x509.NewCertPool()
			roots.AddCert(target.Certificate())
			client, observer, err := newObservedClient("chrome_146", gateway.URL, tls.WithTransportOptions(&tls.TransportOptions{RootCAs: roots}))
			if err != nil {
				t.Fatal(err)
			}
			defer client.CloseIdleConnections()
			for i := 0; i < 3; i++ {
				request, _ := fhttp.NewRequest("GET", target.URL, nil)
				state := observer.start()
				response, err := client.Do(state.attach(request))
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.ReadAll(response.Body)
				_ = response.Body.Close()
				if response.ProtoMajor != map[bool]int{false: 1, true: 2}[http2] {
					t.Fatalf("unexpected negotiated HTTP version %s", response.Proto)
				}
				diagnostic := state.finish(nil)
				if !diagnostic.RequestWritten || !diagnostic.ResponseStarted || diagnostic.Phase != "complete" {
					t.Fatalf("missing target HTTP observations: %+v", diagnostic)
				}
				if i == 0 && (!diagnostic.DialCompleted || diagnostic.ProxyConnectStatus != 200) {
					t.Fatalf("missing actual CONNECT observation: %+v", diagnostic)
				}
				if i == 2 && !diagnostic.ConnectionReused {
					t.Fatalf("expected connection reuse: %+v", diagnostic)
				}
				if i == 0 {
					client.CloseIdleConnections()
				}
			}
		})
	}
}

func TestPOSTWithIdempotencyKeyIsNotReplayedAfterBodyWasReceived(t *testing.T) {
	for _, body := range []string{"", `{"payment":"private-secret"}`} {
		name := "nonempty"
		if body == "" {
			name = "empty"
		}
		t.Run(name, func(t *testing.T) {
			var posts atomic.Int32
			target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					_, _ = io.WriteString(w, "warmup")
					return
				}
				posts.Add(1)
				if body != "" && (r.ContentLength != int64(len(body)) || len(r.TransferEncoding) != 0) {
					t.Error("nonempty POST wire length changed")
				}
				if body == "" && (r.ContentLength != -1 || len(r.TransferEncoding) != 1 || r.TransferEncoding[0] != "chunked") {
					t.Error("expected non-replayable empty chunked POST")
				}
				if r.Header.Get("Idempotency-Key") != "private-idempotency" {
					t.Error("business idempotency key changed")
				}
				received, _ := io.ReadAll(r.Body)
				if string(received) != body {
					t.Error("payment request body changed")
				}
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = conn.Close()
				}
			}))
			defer target.Close()
			gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					return
				}
				defer conn.Close()
				upstream, err := net.Dial("tcp", target.Listener.Addr().String())
				if err != nil {
					return
				}
				defer upstream.Close()
				_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
				go func() { _, _ = io.Copy(upstream, conn); _ = upstream.Close() }()
				_, _ = io.Copy(conn, upstream)
			}))
			defer gateway.Close()
			roots := x509.NewCertPool()
			roots.AddCert(target.Certificate())
			client, observer, err := newObservedClient("chrome_146", gateway.URL, tls.WithTransportOptions(&tls.TransportOptions{RootCAs: roots}))
			if err != nil {
				t.Fatal(err)
			}
			defer client.CloseIdleConnections()
			warmup, _ := newUpstreamRequest(Request{Method: "GET", URL: target.URL})
			state := observer.start()
			response, err := client.Do(state.attach(warmup))
			if err != nil {
				t.Fatal(err)
			}
			_, _ = io.ReadAll(response.Body)
			_ = response.Body.Close()
			request, err := newUpstreamRequest(Request{Method: "POST", URL: target.URL, Body: body, Headers: map[string]string{"Idempotency-Key": "private-idempotency"}})
			if err != nil {
				t.Fatal(err)
			}
			if request.GetBody != nil || request.Body == nil || request.Body == fhttp.NoBody {
				t.Fatal("POST must not be library-replayable")
			}
			state = observer.start()
			_, err = client.Do(state.attach(request))
			if err == nil {
				t.Fatal("expected an ambiguous disconnect after receiving POST")
			}
			if posts.Load() != 1 {
				t.Fatalf("POST was replayed %d times", posts.Load())
			}
			diagnostic := state.finish(err)
			if !diagnostic.RequestWritten || !diagnostic.ConnectionReused || diagnostic.ResponseStarted {
				t.Fatalf("incorrect ambiguous-POST boundary: %+v", diagnostic)
			}
		})
	}
}

func TestDiagnosticConcurrentCallbacks(t *testing.T) {
	state := (&transportObserver{}).start()
	request, _ := fhttp.NewRequest("GET", "https://chatgpt.com/", nil)
	request = state.attach(request)
	_ = request
	done := make(chan struct{})
	for i := 0; i < 20; i++ {
		go func() {
			state.update(func(value *TransportDiagnostic) { value.RequestWritten = true })
			_ = state.finish(io.EOF)
			done <- struct{}{}
		}()
	}
	for i := 0; i < 20; i++ {
		<-done
	}
}

// Keep the net.Error branch exercised with a concrete socket-like timeout.
var _ net.Error = (*net.OpError)(nil)
