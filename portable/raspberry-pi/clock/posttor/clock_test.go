package posttor

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

var actual = time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)

func certificate(t *testing.T, names []string, before, after time.Time) (tls.Certificate, *x509.CertPool) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture CA"}, NotBefore: actual.AddDate(-2, 0, 0), NotAfter: actual.AddDate(2, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := x509.ParseCertificate(caDER)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: names, NotBefore: before, NotAfter: after, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	der, err := x509.CreateCertificate(rand.Reader, leaf, root, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(root)
	return tls.Certificate{Certificate: [][]byte{der, caDER}, PrivateKey: key}, pool
}

type proxyFixture struct {
	listener net.Listener
	mu       sync.Mutex
	hosts    []string
	conns    []net.Conn
	wg       sync.WaitGroup
	target   string
}

func socks(t *testing.T, target string) *proxyFixture {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &proxyFixture{listener: l, target: target}
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		for {
			c, e := l.Accept()
			if e != nil {
				return
			}
			p.mu.Lock()
			p.conns = append(p.conns, c)
			p.mu.Unlock()
			p.wg.Add(1)
			go func() {
				defer p.wg.Done()
				defer c.Close()
				c.SetDeadline(time.Now().Add(3 * time.Second))
				var h [2]byte
				if _, e := io.ReadFull(c, h[:]); e != nil {
					return
				}
				methods := make([]byte, int(h[1]))
				io.ReadFull(c, methods)
				c.Write([]byte{5, 0})
				var req [4]byte
				if _, e := io.ReadFull(c, req[:]); e != nil {
					return
				}
				if req != [4]byte{5, 1, 0, 3} {
					return
				}
				var n [1]byte
				io.ReadFull(c, n[:])
				name := make([]byte, int(n[0]))
				io.ReadFull(c, name)
				var port [2]byte
				io.ReadFull(c, port[:])
				if binary.BigEndian.Uint16(port[:]) != 443 {
					return
				}
				p.mu.Lock()
				p.hosts = append(p.hosts, string(name))
				p.mu.Unlock()
				up, e := net.DialTimeout("tcp", target, time.Second)
				if e != nil {
					return
				}
				defer up.Close()
				up.SetDeadline(time.Now().Add(3 * time.Second))
				c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
				done := make(chan struct{})
				go func() { io.Copy(up, c); close(done) }()
				io.Copy(c, up)
				c.Close()
				up.Close()
				<-done
			}()
		}
	}()
	t.Cleanup(func() {
		l.Close()
		p.mu.Lock()
		for _, c := range p.conns {
			c.Close()
		}
		p.mu.Unlock()
		p.wg.Wait()
	})
	return p
}
func fixture(t *testing.T, cert tls.Certificate, roots *x509.CertPool, handler http.HandlerFunc) (*Poller, *proxyFixture) {
	return fixtureTLS(t, cert, roots, handler, 0)
}
func fixtureTLS(t *testing.T, cert tls.Certificate, roots *x509.CertPool, handler http.HandlerFunc, maximum uint16) (*Poller, *proxyFixture) {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS10, MaxVersion: maximum}
	server.StartTLS()
	t.Cleanup(server.Close)
	proxy := socks(t, server.Listener.Addr().String())
	p, err := New(Config{Sources: [3]string{"https://one.invalid/time", "https://two.invalid/time", "https://three.invalid/time"}, SOCKS: "socks5h://" + proxy.listener.Addr().String(), Roots: roots, Earliest: actual.AddDate(-1, 0, 0), Latest: actual.AddDate(1, 0, 0), MaxStep: 48 * time.Hour, MaxSpread: 10 * time.Second, Timeout: time.Second, MaxUncertainty: 2 * time.Second, DecisionTTL: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return p, proxy
}
func names() []string { return []string{"one.invalid", "two.invalid", "three.invalid"} }
func good(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Date", actual.Format(http.TimeFormat))
}

// Actual local TLS handshakes and SOCKS5 domain-name requests, not mocked HTTP.
func TestFutureCertificateAndRecordedSetter(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	p, proxy := fixture(t, cert, roots, good)
	// Names are .invalid; an OS DNS lookup would fail. Additionally deny resolution.
	old := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(context.Context, string, string) (net.Conn, error) { return nil, errors.New("OS DNS forbidden") }}
	defer func() { net.DefaultResolver = old }()
	decision, err := p.Poll(context.Background(), actual.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	recorded := []time.Time{}
	record := func(d Application) { recorded = append(recorded, d.UTC) }
	applied, err := decision.Consume()
	if err != nil {
		t.Fatal(err)
	}
	record(applied)
	if _, err := decision.Consume(); err == nil {
		t.Fatal("decision replay")
	}
	if len(recorded) != 1 || recorded[0].Before(actual) || recorded[0].After(actual.Add(time.Second)) {
		t.Fatal(recorded)
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if strings.Join(proxy.hosts, ",") != "one.invalid,two.invalid,three.invalid" {
		t.Fatal(proxy.hosts)
	}
}
func TestCertificateRefusals(t *testing.T) {
	for _, kind := range []string{"hostname", "root", "expired"} {
		t.Run(kind, func(t *testing.T) {
			n := names()
			before, after := actual.Add(-time.Hour), actual.Add(time.Hour)
			if kind == "hostname" {
				n = []string{"wrong.invalid"}
			}
			if kind == "expired" {
				before = actual.Add(-48 * time.Hour)
				after = actual.Add(-time.Hour)
			}
			cert, roots := certificate(t, n, before, after)
			if kind == "root" {
				roots = x509.NewCertPool()
			}
			p, _ := fixture(t, cert, roots, good)
			if _, err := p.Poll(context.Background(), actual); err == nil {
				t.Fatal("accepted", kind)
			}
		})
	}
}
func TestResponseRefusals(t *testing.T) {
	cases := map[string]http.HandlerFunc{
		"redirect": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Location", "https://other.invalid")
			w.WriteHeader(302)
		},
		"oversized": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Padding", strings.Repeat("x", 9000))
			good(w, r)
		},
		"bad-date": func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Date", "no") },
		"duplicate-date": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Add("Date", actual.Format(http.TimeFormat))
			w.Header().Add("Date", actual.Format(http.TimeFormat))
		},
		"large-step": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Date", actual.Add(72*time.Hour).Format(http.TimeFormat))
		},
		"disagree": func(w http.ResponseWriter, r *http.Request) {
			d := actual
			if r.Host == "three.invalid" {
				d = d.Add(time.Minute)
			}
			w.Header().Set("Date", d.Format(http.TimeFormat))
		},
		"hang": func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() },
	}
	for name, handler := range cases {
		t.Run(name, func(t *testing.T) {
			cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
			p, _ := fixture(t, cert, roots, handler)
			p.config.Timeout = 150 * time.Millisecond
			begin := time.Now()
			recorded := false
			if d, err := p.Poll(context.Background(), actual); err == nil {
				_ = d
				recorded = true
			}
			if recorded {
				t.Fatal("would set clock")
			}
			if time.Since(begin) > 2*time.Second {
				t.Fatal("unbounded observation")
			}
		})
	}
}
func TestNoDirectFallback(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	p, proxy := fixture(t, cert, roots, func(w http.ResponseWriter, r *http.Request) { t.Error("unexpected HTTP request") })
	proxy.listener.Close()
	if _, err := p.Poll(context.Background(), actual); err == nil {
		t.Fatal("accepted dead proxy")
	}
}
func TestPolicyRefusalsAndCancellation(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	p, proxy := fixture(t, cert, roots, good)
	for _, proxyURL := range []string{"", "http://127.0.0.1:9050", "socks5h://example.org:9050", "socks5h://u:p@127.0.0.1:9050"} {
		c := p.config
		c.SOCKS = proxyURL
		if _, e := New(c); e == nil {
			t.Fatal(proxyURL)
		}
	}
	c := p.config
	c.Sources[0] = "http://one.invalid"
	if _, e := New(c); e == nil {
		t.Fatal("http accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, e := p.Poll(ctx, actual); e == nil {
		t.Fatal("cancelled accepted")
	}
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if len(proxy.hosts) != 0 {
		t.Fatal("cancelled request sent")
	}
	if e := verify(nil, "one.invalid", roots, actual); e == nil {
		t.Fatal("empty cert accepted")
	}
}

func TestDelayedObservationsAndExpiry(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	start := time.Now()
	p, _ := fixture(t, cert, roots, func(w http.ResponseWriter, r *http.Request) {
		// Date generated before a delayed reply, as can happen in a real server.
		date := actual.Add(time.Since(start))
		time.Sleep(400 * time.Millisecond)
		w.Header().Set("Date", date.Format(http.TimeFormat))
	})
	p.config.Timeout = 3 * time.Second
	p.config.DecisionTTL = 50 * time.Millisecond
	d, err := p.Poll(context.Background(), actual)
	if err != nil {
		t.Fatal(err)
	}
	app, err := d.Consume()
	if err != nil {
		t.Fatal(err)
	}
	expected := actual.Add(time.Since(start))
	delta := app.UTC.Sub(expected)
	if delta < 0 {
		delta = -delta
	}
	if delta > app.Uncertainty || app.Uncertainty > p.config.MaxUncertainty {
		t.Fatalf("decision %v expected %v uncertainty %v", app.UTC, expected, app.Uncertainty)
	}
	if app.UTC.Before(actual.Add(800 * time.Millisecond)) {
		t.Fatal("returned stale raw median")
	}
	d, err = p.Poll(context.Background(), actual.Add(time.Since(start)))
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(60 * time.Millisecond)
	if _, err = d.Consume(); err == nil {
		t.Fatal("expired decision accepted")
	}
	p.config.MaxUncertainty = 100 * time.Millisecond
	if _, err = p.Poll(context.Background(), actual.Add(time.Since(start))); err == nil {
		t.Fatal("excessive uncertainty accepted")
	}
}

func TestLegacyTLSRefused(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	p, _ := fixtureTLS(t, cert, roots, good, tls.VersionTLS11)
	if _, err := p.Poll(context.Background(), actual); err == nil {
		t.Fatal("TLS1.1 accepted")
	}
}
func TestBootClockAndExpiredDecision(t *testing.T) {
	before, err := bootNow()
	if err != nil {
		t.Fatal(err)
	}
	after, err := bootNow()
	if err != nil || after < before {
		t.Fatal("boot clock unavailable/regressed", err)
	}
	d := Decision{state: &decisionState{utc: actual, uncertainty: time.Second, issued: before - time.Second, ttl: time.Millisecond}}
	if _, err := d.Consume(); err == nil {
		t.Fatal("expired boot-time decision accepted")
	}
	if _, err := d.Consume(); err == nil {
		t.Fatal("expired decision reopened")
	}
}

// These exercise actual TLS observations whose raw Date passes fetch admission,
// but whose projected application uncertainty must not pass the tighter policy.
func TestProjectedPolicyBoundaries(t *testing.T) {
	for _, kind := range []string{"latest", "forward-step"} {
		t.Run(kind, func(t *testing.T) {
			cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
			p, _ := fixture(t, cert, roots, good)
			now := actual
			switch kind {
			case "latest":
				p.config.Latest = actual
			case "forward-step":
				now = actual.Add(-p.config.MaxStep)
			}
			_, err := p.Poll(context.Background(), now)
			if err == nil || !strings.Contains(err.Error(), "projected uncertainty") {
				t.Fatalf("%s accepted or wrong boundary: %v", kind, err)
			}
		})
	}
}
func TestConsumeRemainingClippedByLatest(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	p, _ := fixture(t, cert, roots, good)
	p.config.Latest = actual.Add(2 * time.Second)
	p.config.DecisionTTL = 3 * time.Second
	d, err := p.Poll(context.Background(), actual)
	if err != nil {
		t.Fatal(err)
	}
	applied, err := d.Consume()
	if err != nil {
		t.Fatal(err)
	}
	if applied.Remaining <= 0 || applied.Remaining >= 2*time.Second || applied.UTC.Add(applied.Uncertainty).Add(applied.Remaining).After(p.config.Latest) {
		t.Fatal("remaining lifetime crosses latest", applied)
	}
}

func TestConsumeCrossesLatest(t *testing.T) {
	cert, roots := certificate(t, names(), actual.Add(-time.Hour), actual.Add(time.Hour))
	p, _ := fixture(t, cert, roots, good)
	p.config.Latest = actual.Add(2 * time.Second)
	p.config.DecisionTTL = 3 * time.Second
	d, err := p.Poll(context.Background(), actual)
	if err != nil {
		t.Fatal(err)
	}
	// A real elapsed delay within TTL crosses the upper policy bound even though
	// the originally observed Date and admitted decision both fitted it.
	time.Sleep(1200 * time.Millisecond)
	_, err = d.Consume()
	if err == nil || !strings.Contains(err.Error(), "outside trusted bounds") {
		t.Fatal("consumption failed to recheck interval", err)
	}
	if _, err = d.Consume(); err == nil {
		t.Fatal("failed consumption reopened")
	}
}
