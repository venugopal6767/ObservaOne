package agent

// Pull mode: Prometheus scrapes this agent over HTTPS.
//
//   - The server certificate is issued by the ObservaOne server (its own small "agent CA") for the
//     addresses this host has; the private key is made here and never leaves the host.
//   - Every connection must present a client certificate from the same CA with the name the server
//     gave us (observaone-prometheus): only ObservaOne's Prometheus can read the metrics.
//   - pull.allow can restrict the source addresses further.
//   - The certificate is renewed when it is 2/3 through its life or when this host's addresses change.

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"observaone/agent/internal/core"
)

type pullState struct {
	mu         sync.Mutex
	cert       *tls.Certificate
	leaf       *x509.Certificate
	clientCAs  *x509.CertPool
	clientName string
	listening  bool
	err        string
	scrapes    atomic.Uint64
	lastScrape atomic.Int64 // unix ms
	refused    atomic.Uint64
}

func (a *Agent) pull() *pullState {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.pullSt == nil {
		a.pullSt = &pullState{}
	}
	return a.pullSt
}

func (p *pullState) setErr(s string) {
	p.mu.Lock()
	p.err = s
	p.mu.Unlock()
}

// pullAddresses: what goes into the certificate and what the server may use as the scrape address.
// pull.advertise wins; otherwise every non-loopback, non-link-local address of this host (max 8).
func pullAddresses(cfg *core.Config) (ips []string, dns []string) {
	if a := cfg.PullAdvertise; a != "" {
		h := a
		if hh, _, err := net.SplitHostPort(a); err == nil {
			h = hh
		}
		if ip := net.ParseIP(h); ip != nil {
			return []string{ip.String()}, nil
		}
		return nil, []string{strings.ToLower(h)}
	}
	ifs, _ := net.Interfaces()
	for _, in := range ifs {
		if in.Flags&net.FlagUp == 0 || in.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := in.Addrs()
		for _, ad := range addrs {
			n, ok := ad.(*net.IPNet)
			if !ok || n.IP.IsLoopback() || n.IP.IsLinkLocalUnicast() || n.IP.IsMulticast() {
				continue
			}
			ips = append(ips, n.IP.String())
		}
	}
	sort.SliceStable(ips, func(i, j int) bool { // IPv4 first, then by text
		a4, b4 := net.ParseIP(ips[i]).To4() != nil, net.ParseIP(ips[j]).To4() != nil
		if a4 != b4 {
			return a4
		}
		return ips[i] < ips[j]
	})
	if len(ips) > 8 {
		ips = ips[:8]
	}
	return ips, nil
}

// pullPort is the port Prometheus must use.
func pullPort(cfg *core.Config) int {
	if a := cfg.PullAdvertise; a != "" {
		if _, p, err := net.SplitHostPort(a); err == nil {
			n, _ := strconv.Atoi(p)
			return n
		}
	}
	_, p, _ := net.SplitHostPort(cfg.PullListen)
	n, _ := strconv.Atoi(p)
	return n
}

func pullFiles(stateDir string) (key, crt, ca string) {
	return filepath.Join(stateDir, "pull.key"), filepath.Join(stateDir, "pull.crt"), filepath.Join(stateDir, "pull-ca.crt")
}

// loadOrCreateKey keeps one P-256 key per install (0600, owned by the agent user).
func loadOrCreateKey(path string) (*ecdsa.PrivateKey, error) {
	if b, err := os.ReadFile(path); err == nil {
		blk, _ := pem.Decode(b)
		if blk != nil {
			if k, err := x509.ParseECPrivateKey(blk.Bytes); err == nil {
				return k, nil
			}
		}
		return nil, fmt.Errorf("%s is damaged; delete it and restart the agent", path)
	}
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalECPrivateKey(k)
	if err := core.WriteFileAtomic(path, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	return k, nil
}

// certNeedsRenewal: missing, for another key, 2/3 through its life, or not covering the wanted addresses.
func certNeedsRenewal(leaf *x509.Certificate, key *ecdsa.PrivateKey, ips, dns []string, now time.Time) string {
	if leaf == nil {
		return "no certificate yet"
	}
	if pk, ok := leaf.PublicKey.(*ecdsa.PublicKey); !ok || !pk.Equal(&key.PublicKey) {
		return "certificate is for another key"
	}
	life := leaf.NotAfter.Sub(leaf.NotBefore)
	if now.After(leaf.NotBefore.Add(life * 2 / 3)) {
		return "certificate is due for renewal"
	}
	have := map[string]bool{}
	for _, ip := range leaf.IPAddresses {
		have[ip.String()] = true
	}
	for _, d := range leaf.DNSNames {
		have[strings.ToLower(d)] = true
	}
	for _, x := range append(append([]string{}, ips...), dns...) {
		if !have[x] {
			return "addresses changed (" + x + " is new)"
		}
	}
	return ""
}

type pullCertAnswer struct {
	Certificate string `json:"certificate"`
	CA          string `json:"ca"`
	ClientName  string `json:"clientName"`
}

// ensurePullCert loads the certificate from disk and asks the server for a new one when needed.
func (a *Agent) ensurePullCert(ctx context.Context) error {
	cfg := a.Config()
	p := a.pull()
	keyPath, crtPath, caPath := pullFiles(cfg.StateDir)
	key, err := loadOrCreateKey(keyPath)
	if err != nil {
		return err
	}
	ips, dns := pullAddresses(cfg)
	var leaf *x509.Certificate
	crtPEM, err1 := os.ReadFile(crtPath)
	caPEM, err2 := os.ReadFile(caPath)
	if err1 == nil && err2 == nil {
		if blk, _ := pem.Decode(crtPEM); blk != nil {
			leaf, _ = x509.ParseCertificate(blk.Bytes)
		}
	}
	reason := certNeedsRenewal(leaf, key, ips, dns, time.Now())
	clientName := ""
	if b, err := os.ReadFile(caPath + ".client"); err == nil {
		clientName = strings.TrimSpace(string(b))
	}
	if reason != "" || clientName == "" {
		if reason == "" {
			reason = "client name unknown"
		}
		pub, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
		a.mu.Lock()
		cl, cred, id := a.client, a.cred, a.id.AgentID
		a.mu.Unlock()
		var ans pullCertAnswer
		body := map[string]any{"publicKey": base64.StdEncoding.EncodeToString(pub), "ips": ips, "dns": dns, "port": pullPort(cfg)}
		if err := cl.PostJSON(ctx, core.AgentPath(id, "pull-certificate"), cred, body, &ans); err != nil {
			return fmt.Errorf("pull certificate (%s): %w", reason, err)
		}
		if ans.Certificate == "" || ans.CA == "" || ans.ClientName == "" {
			return fmt.Errorf("pull certificate: incomplete answer from the server")
		}
		crtPEM, caPEM, clientName = []byte(ans.Certificate), []byte(ans.CA), ans.ClientName
		if err := core.WriteFileAtomic(crtPath, crtPEM, 0o644); err != nil {
			return err
		}
		if err := core.WriteFileAtomic(caPath, caPEM, 0o644); err != nil {
			return err
		}
		if err := core.WriteFileAtomic(caPath+".client", []byte(clientName+"\n"), 0o644); err != nil {
			return err
		}
		a.Log.Info("pull certificate issued", "reason", reason, "ips", strings.Join(ips, ","), "dns", strings.Join(dns, ","))
	}
	kder, _ := x509.MarshalECPrivateKey(key)
	tc, err := tls.X509KeyPair(crtPEM, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder}))
	if err != nil {
		return fmt.Errorf("pull certificate does not match the key: %w", err)
	}
	leaf, err = x509.ParseCertificate(tc.Certificate[0])
	if err != nil {
		return err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return fmt.Errorf("%s holds no certificate", caPath)
	}
	p.mu.Lock()
	p.cert, p.leaf, p.clientCAs, p.clientName = &tc, leaf, pool, clientName
	p.mu.Unlock()
	return nil
}

func (p *pullState) tlsConfig() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
			p.mu.Lock()
			defer p.mu.Unlock()
			if p.cert == nil {
				return nil, errors.New("no certificate yet")
			}
			return p.cert, nil
		},
		GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) {
			p.mu.Lock()
			cert, pool, name := p.cert, p.clientCAs, p.clientName
			p.mu.Unlock()
			if cert == nil {
				return nil, errors.New("no certificate yet")
			}
			return &tls.Config{
				MinVersion:   tls.VersionTLS12,
				Certificates: []tls.Certificate{*cert},
				ClientAuth:   tls.RequireAndVerifyClientCert,
				ClientCAs:    pool,
				VerifyConnection: func(cs tls.ConnectionState) error {
					if len(cs.PeerCertificates) == 0 || cs.PeerCertificates[0].Subject.CommonName != name {
						return errors.New("client certificate is not ObservaOne's Prometheus")
					}
					return nil
				},
			}, nil
		},
	}
}

// allowListener closes connections from addresses outside pull.allow before any TLS work.
type allowListener struct {
	net.Listener
	a *Agent
}

func (l allowListener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		host, _, _ := net.SplitHostPort(c.RemoteAddr().String())
		if ip := net.ParseIP(host); ip != nil && l.a.Config().PullAllowed(ip) {
			return c, nil
		}
		l.a.pull().refused.Add(1)
		_ = c.Close()
	}
}

// pullLoop gets a certificate (retrying while the server is unreachable), serves /metrics,
// and re-checks the certificate every 10 minutes (renewal, address changes).
func (a *Agent) pullLoop(ctx context.Context) {
	cfg := a.Config()
	p := a.pull()
	bo := &core.Backoff{Base: 5 * time.Second, Max: 5 * time.Minute}
	for {
		err := a.ensurePullCert(ctx)
		if err == nil {
			p.setErr("")
			break
		}
		a.Log.Warn("pull mode: no certificate yet, retrying", "error", err.Error())
		p.setErr(err.Error())
		select {
		case <-ctx.Done():
			return
		case <-time.After(bo.Next()):
		}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		a.mu.Lock()
		t := a.lastText
		a.mu.Unlock()
		p.scrapes.Add(1)
		p.lastScrape.Store(time.Now().UnixMilli())
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = w.Write([]byte(t))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second,
		TLSConfig: p.tlsConfig(),
		// handshake errors from probes (TCP connect, then close) and refused clients would flood the journal;
		// refused connections are counted and reported in the heartbeat instead
		ErrorLog: log.New(io.Discard, "", 0)}
	ln, err := net.Listen("tcp", cfg.PullListen)
	if err != nil {
		msg := fmt.Sprintf("pull mode: cannot listen on %s: %v", cfg.PullListen, err)
		a.Log.Error(msg)
		p.setErr(msg)
		a.setErr(msg)
		return
	}
	p.mu.Lock()
	p.listening = true
	p.mu.Unlock()
	a.Log.Info("pull mode: serving metrics for Prometheus", "listen", cfg.PullListen, "port", pullPort(cfg))
	go func() { _ = srv.ServeTLS(allowListener{ln, a}, "", "") }()
	defer func() {
		_ = srv.Close()
		p.mu.Lock()
		p.listening = false
		p.mu.Unlock()
	}()
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
			if err := a.ensurePullCert(ctx); err != nil {
				a.Log.Warn("pull certificate renewal failed (the current one is still used)", "error", err.Error())
				p.setErr(err.Error())
			} else {
				p.setErr("")
			}
		}
	}
}

// pullReport goes into every heartbeat.
func (a *Agent) pullReport() map[string]any {
	cfg := a.Config()
	p := a.pull()
	ips, dns := pullAddresses(cfg)
	p.mu.Lock()
	defer p.mu.Unlock()
	m := map[string]any{"port": pullPort(cfg), "ips": ips, "dns": dns, "listening": p.listening, "scrapes": p.scrapes.Load(),
		"refused": p.refused.Load()}
	if p.err != "" {
		m["error"] = p.err
	}
	if p.leaf != nil {
		m["certNotAfter"] = p.leaf.NotAfter.Unix()
	}
	if t := p.lastScrape.Load(); t > 0 {
		m["lastScrapeAgoSeconds"] = int(time.Since(time.UnixMilli(t)).Seconds())
	}
	return m
}
