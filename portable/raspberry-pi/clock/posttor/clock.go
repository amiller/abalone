// SPDX-License-Identifier: GPL-3.0-only
// Certificate-time verification adapted from the Tails https-get-expired helper.
// Go-derived verification behavior: Copyright 2009 The Go Authors.
// See NOTICE, COPYING and GO-LICENSE. This is not authenticated Tails release source.
package posttor

import (
	"context"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Config comes exclusively from the trusted host, never an agent/UI request.
// There are deliberately no default sources, proxy, clock bounds or root store.
// Roots nil means the OS trust store; tests supply an isolated synthetic CA.
type Config struct {
	Sources                     [3]string
	SOCKS                       string
	Roots                       *x509.CertPool
	Earliest, Latest            time.Time
	MaxStep, MaxSpread, Timeout time.Duration
	MaxUncertainty, DecisionTTL time.Duration
}

type Poller struct {
	config Config
	urls   [3]*url.URL
	proxy  *url.URL
}

// Decision is an observation, not authority to set time or open financial admission.
// The host must exclude financial work, apply within the same bounded transaction,
// read back, and invalidate earlier wall-clock decisions. No setter is provided here.
// Decision carries an opaque, one-shot observation. Its monotonic lifetime cannot
// be reconstructed from JSON. The host must consume immediately before a bounded
// privileged apply/readback; consumption itself never changes a clock.
type Decision struct{ state *decisionState }
type decisionState struct {
	mu                          sync.Mutex
	consumed                    bool
	utc                         time.Time
	uncertainty                 time.Duration
	issued                      time.Duration
	ttl                         time.Duration
	earliest, latest, reference time.Time
	maxStep                     time.Duration
}
type Application struct {
	UTC         time.Time
	Uncertainty time.Duration
	Remaining   time.Duration
}

func (d Decision) Consume() (Application, error) {
	if d.state == nil {
		return Application{}, errors.New("missing clock decision")
	}
	s := d.state
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.consumed {
		return Application{}, errors.New("clock decision already consumed")
	}
	s.consumed = true
	stamp, err := bootNow()
	if err != nil {
		return Application{}, err
	}
	elapsed := stamp - s.issued
	if elapsed < 0 || elapsed >= s.ttl {
		return Application{}, errors.New("clock decision expired")
	}
	target := s.utc.Add(elapsed)
	if !withinPolicy(target, s.uncertainty, s.reference.Add(elapsed), s.earliest, s.latest, s.maxStep) {
		return Application{}, errors.New("projected clock decision outside trusted bounds")
	}
	remaining := s.ttl - elapsed
	if margin := s.latest.Sub(target.Add(s.uncertainty)); margin < remaining {
		remaining = margin
	}
	if remaining <= 0 {
		return Application{}, errors.New("clock policy has no remaining lifetime")
	}
	return Application{UTC: target, Uncertainty: s.uncertainty, Remaining: remaining}, nil
}

// Check the entire symmetric interval exposed to the eventual setter, not only
// its midpoint or the raw HTTP Date. Reference advances on the same boot clock.
func withinPolicy(target time.Time, uncertainty time.Duration, reference, earliest, latest time.Time, maxStep time.Duration) bool {
	lower, upper := target.Add(-uncertainty), target.Add(uncertainty)
	return !lower.Before(earliest) && !upper.After(latest) &&
		!lower.Before(reference.Add(-maxStep)) && !upper.After(reference.Add(maxStep))
}

func New(c Config) (*Poller, error) {
	if c.Earliest.IsZero() || !c.Latest.After(c.Earliest) || c.MaxStep <= 0 || c.MaxStep > 366*24*time.Hour || c.MaxSpread <= 0 || c.MaxSpread > 5*time.Minute || c.Timeout <= 0 || c.Timeout > 30*time.Second || c.MaxUncertainty <= 0 || c.MaxUncertainty > 5*time.Minute || c.DecisionTTL <= 0 || c.DecisionTTL > 5*time.Second {
		return nil, errors.New("invalid trusted clock policy")
	}
	proxy, err := url.Parse(c.SOCKS)
	if err != nil || proxy.Scheme != "socks5h" || proxy.User != nil || proxy.Path != "" || proxy.RawQuery != "" || proxy.Fragment != "" || proxy.Port() == "" {
		return nil, errors.New("fixed SOCKS proxy required")
	}
	ip := net.ParseIP(proxy.Hostname())
	if ip == nil || !ip.IsLoopback() {
		return nil, errors.New("proxy must be literal loopback")
	}
	port, err := strconv.Atoi(proxy.Port())
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("invalid proxy address")
	}
	p := &Poller{config: c, proxy: proxy}
	seen := map[string]bool{}
	for i, s := range c.Sources {
		u, e := url.Parse(s)
		if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || seen[strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))] {
			return nil, errors.New("three distinct fixed HTTPS sources required")
		}
		if net.ParseIP(u.Hostname()) != nil {
			return nil, errors.New("source must have DNS hostname")
		}
		seen[strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))] = true
		p.urls[i] = u
	}
	// Copy roots so a caller cannot mutate the active verifier after construction.
	if c.Roots != nil {
		p.config.Roots = c.Roots.Clone()
	}
	return p, nil
}

// verify mirrors Tails' reject-expired mode: when our clock precedes the leaf's
// NotBefore, verify the entire chain at NotBefore+1s; otherwise verify at now.
// This intentionally relaxes time validity only, NOT hostname or issuer trust.
// It does not establish freshness or protect against a compromised time source.
func verify(raw [][]byte, host string, roots *x509.CertPool, now time.Time) error {
	if len(raw) == 0 || len(raw) > 16 {
		return errors.New("invalid certificate chain length")
	}
	certs := make([]*x509.Certificate, len(raw))
	total := 0
	for i, b := range raw {
		total += len(b)
		if total > 256*1024 {
			return errors.New("certificate chain too large")
		}
		cert, err := x509.ParseCertificate(b)
		if err != nil {
			return err
		}
		if key, ok := cert.PublicKey.(*rsa.PublicKey); ok && key.N.BitLen() > 8192 {
			return errors.New("RSA key too large")
		}
		certs[i] = cert
	}
	at := now
	if certs[0].NotBefore.After(now) {
		at = certs[0].NotBefore.Add(time.Second)
	}
	intermediate := x509.NewCertPool()
	for _, c := range certs[1:] {
		intermediate.AddCert(c)
	}
	_, err := certs[0].Verify(x509.VerifyOptions{Roots: roots, DNSName: host, Intermediates: intermediate, CurrentTime: at})
	return err
}

func (p *Poller) fetch(ctx context.Context, u *url.URL, now time.Time) (time.Time, error) {
	transport := &http.Transport{
		Proxy:                  http.ProxyURL(p.proxy), // Explicit SOCKS hostname forwarding, never env/direct.
		MaxResponseHeaderBytes: 8192,
		DisableKeepAlives:      true,
		TLSHandshakeTimeout:    p.config.Timeout,
		ResponseHeaderTimeout:  p.config.Timeout,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, // custom full verification below
			VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
				return verify(raw, u.Hostname(), p.config.Roots, now)
			},
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: p.config.Timeout, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("redirect refused") }}
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, u.String(), nil)
	if err != nil {
		return time.Time{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		return time.Time{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return time.Time{}, errors.New("time source refused")
	}
	values := response.Header.Values("Date")
	if len(values) != 1 || len(values[0]) > 64 {
		return time.Time{}, errors.New("one bounded Date required")
	}
	date, err := http.ParseTime(values[0])
	if err != nil {
		return time.Time{}, errors.New("invalid Date")
	}
	if date.Before(p.config.Earliest) || date.After(p.config.Latest) {
		return time.Time{}, errors.New("Date outside trusted bounds")
	}
	if step := date.Sub(now); step > p.config.MaxStep || step < -p.config.MaxStep {
		return time.Time{}, errors.New("correction exceeds trusted bound")
	}
	return date.UTC(), nil
}

// Poll makes one HEAD attempt per source, with one overall deadline and no retry.
// All three sources must agree within MaxSpread; median is returned. Different
// hostnames are not proof of independent organizations or trustworthy clocks.
func (p *Poller) Poll(parent context.Context, now time.Time) (Decision, error) {
	ctx, cancel := context.WithTimeout(parent, p.config.Timeout)
	defer cancel()
	if now.IsZero() {
		return Decision{}, errors.New("current clock required")
	}
	type sample struct {
		date       time.Time
		start, end time.Duration
	}
	var samples []sample
	pollStart, err := bootNow()
	if err != nil {
		return Decision{}, err
	}
	for _, u := range p.urls {
		if err := ctx.Err(); err != nil {
			return Decision{}, err
		}
		start, err := bootNow()
		if err != nil {
			return Decision{}, err
		}
		if start < pollStart || start-pollStart >= p.config.Timeout {
			return Decision{}, errors.New("suspend-aware poll deadline")
		}
		date, err := p.fetch(ctx, u, now.Add(start-pollStart))
		end, clockErr := bootNow()
		if clockErr != nil {
			return Decision{}, clockErr
		}
		if end < start || end-pollStart >= p.config.Timeout {
			return Decision{}, errors.New("suspend-aware poll deadline")
		}
		if err != nil {
			return Decision{}, fmt.Errorf("time observation failed: %w", err)
		}
		samples = append(samples, sample{date, start, end})
	}
	if err := ctx.Err(); err != nil {
		return Decision{}, err
	}
	finish, err := bootNow()
	if err != nil {
		return Decision{}, err
	}
	if finish < pollStart || finish-pollStart >= p.config.Timeout {
		return Decision{}, errors.New("suspend-aware poll deadline")
	}
	var dates []time.Time
	var lower, upper time.Time
	for _, v := range samples {
		// Assuming honest Date generation during this request, second-resolution Date
		// brackets server time within [Date,Date+1s). Network delay is not zero.
		lo := v.date.Add(finish - v.end)
		hi := v.date.Add(time.Second).Add(finish - v.start)
		dates = append(dates, lo.Add(hi.Sub(lo)/2))
		if lower.IsZero() || lo.Before(lower) {
			lower = lo
		}
		if upper.IsZero() || hi.After(upper) {
			upper = hi
		}
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
	if dates[2].Sub(dates[0]) > p.config.MaxSpread {
		return Decision{}, errors.New("time sources disagree")
	}
	selected := dates[1]
	uncertainty := selected.Sub(lower)
	if upper.Sub(selected) > uncertainty {
		uncertainty = upper.Sub(selected)
	}
	if uncertainty > p.config.MaxUncertainty {
		return Decision{}, errors.New("time uncertainty exceeds trusted bound")
	}
	reference := now.Add(finish - pollStart)
	if !withinPolicy(selected, uncertainty, reference, p.config.Earliest, p.config.Latest, p.config.MaxStep) {
		return Decision{}, errors.New("projected uncertainty interval outside trusted bounds")
	}
	return Decision{state: &decisionState{utc: selected, uncertainty: uncertainty, issued: finish, ttl: p.config.DecisionTTL,
		earliest: p.config.Earliest, latest: p.config.Latest, reference: reference, maxStep: p.config.MaxStep}}, nil
}
