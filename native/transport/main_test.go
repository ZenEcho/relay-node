package main

import (
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	tls "github.com/bogdanfinn/tls-client"
)

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
