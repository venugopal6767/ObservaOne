package core

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"time"
)

// Client talks to the ObservaOne server over HTTPS with certificate verification ALWAYS on.
// There is no "insecure" switch: a wrong or expired certificate is an error, never a silent fallback.
type Client struct {
	server  string
	http    *http.Client
	ua      string
	version string
}

func NewClient(cfg *Config, version string) (*Client, error) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("ca_file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("ca_file %s holds no PEM certificate", cfg.CAFile)
		}
		tlsCfg.RootCAs = pool // only this CA: a self-signed server certificate is pinned this way
	}
	tr := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tlsCfg,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 20 * time.Second,
		MaxIdleConns:          2,
		IdleConnTimeout:       90 * time.Second,
	}
	return &Client{
		server:  cfg.Server,
		http:    &http.Client{Transport: tr, Timeout: 30 * time.Second},
		ua:      fmt.Sprintf("ObservaOne-Agent/%s (%s; %s)", version, runtime.GOOS, runtime.GOARCH),
		version: version,
	}, nil
}

// APIError is an answer from the server that was not 2xx.
type APIError struct {
	Status int
	Code   string
	Msg    string
	Retry  time.Duration // from Retry-After, if any
}

func (e *APIError) Error() string {
	if e.Msg != "" {
		return fmt.Sprintf("server answered %d %s: %s", e.Status, e.Code, e.Msg)
	}
	return fmt.Sprintf("server answered HTTP %d", e.Status)
}

// Retryable: worth trying again later (server busy/down). 4xx other than 408/429 are not.
func (e *APIError) Retryable() bool { return e.Status >= 500 || e.Status == 408 || e.Status == 429 }

// PostJSON sends body as JSON with "Authorization: Bearer <secret>" and decodes the answer into out.
func (c *Client) PostJSON(ctx context.Context, path, secret string, body, out any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return c.do(ctx, path, secret, "application/json", "", b, nil, out)
}

// PostMetrics sends a gzip-compressed Prometheus text payload.
func (c *Client) PostMetrics(ctx context.Context, secret, text string, collectedAtMs int64) error {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	_, _ = zw.Write([]byte(text))
	_ = zw.Close()
	h := map[string]string{
		// lets the server correct for a wrong clock on this host (it compares with its own time)
		"X-Agent-Time":   strconv.FormatInt(time.Now().UnixMilli(), 10),
		"X-Collected-At": strconv.FormatInt(collectedAtMs, 10),
	}
	return c.do(ctx, "/api/agent/v1/metrics", secret, "text/plain; version=0.0.4", "gzip", buf.Bytes(), h, nil)
}

func (c *Client) do(ctx context.Context, path, secret, ctype, enc string, body []byte, hdr map[string]string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.server+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", ctype)
	if enc != "" {
		req.Header.Set("Content-Encoding", enc)
	}
	req.Header.Set("User-Agent", c.ua)
	req.Header.Set("Authorization", "Bearer "+secret)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return explainNetErr(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		ae := &APIError{Status: resp.StatusCode}
		var e struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if json.Unmarshal(data, &e) == nil {
			ae.Msg, ae.Code = e.Error, e.Code
		}
		if s, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && s > 0 && s < 3600 {
			ae.Retry = time.Duration(s) * time.Second
		}
		return ae
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// explainNetErr turns transport errors into something an operator can act on.
func explainNetErr(err error) error {
	var cv *tls.CertificateVerificationError
	var ua x509.UnknownAuthorityError
	var hn x509.HostnameError
	var ci x509.CertificateInvalidError
	switch {
	case errors.As(err, &cv), errors.As(err, &ua):
		return fmt.Errorf("TLS: the server certificate is not trusted (set ca_file to the ObservaOne CA, or check you reach the right server): %w", err)
	case errors.As(err, &hn):
		return fmt.Errorf("TLS: the certificate does not match the server name in 'server': %w", err)
	case errors.As(err, &ci):
		return fmt.Errorf("TLS: the server certificate is invalid or expired: %w", err)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("timeout talking to the server (firewall or routing? outbound 443 must be open): %w", err)
	}
	return fmt.Errorf("cannot reach the server: %w", err)
}

// Backoff: exponential with full jitter, capped. Avoids retry storms when the server is down:
// 1000 agents spread their retries over the whole window instead of hitting it together.
type Backoff struct {
	Base, Max time.Duration
	n         int
}

func (b *Backoff) Next() time.Duration {
	d := b.Base << b.n
	if d > b.Max || d <= 0 {
		d = b.Max
	} else {
		b.n++
	}
	return time.Duration(rand.Int63n(int64(d))) + b.Base/2
}

func (b *Backoff) Reset() { b.n = 0 }
