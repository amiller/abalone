// SPDX-License-Identifier: MIT
// Fixed root command. No public socket, CLI options, environment configuration or defaults.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	clock "portable-clock/posttor"
)

const configPath = "/opt/portable/etc/clock.json"
const lockPath = "/run/.portable-vault-lifecycle.lock"
const readyDir = "/run/portable-clock"
const readyPath = readyDir + "/ready.json"

type policy struct {
	Sources             [3]string `json:"sources"`
	SOCKS               string    `json:"socks"`
	Earliest            string    `json:"earliest"`
	Latest              string    `json:"latest"`
	MaxStepNs           int64     `json:"maxStepNs"`
	MaxSpreadNs         int64     `json:"maxSpreadNs"`
	TimeoutNs           int64     `json:"timeoutNs"`
	MaxUncertaintyNs    int64     `json:"maxUncertaintyNs"`
	DecisionTTLNs       int64     `json:"decisionTTLNs"`
	ApplyBudgetNs       int64     `json:"applyBudgetNs"`
	ReadbackToleranceNs int64     `json:"readbackToleranceNs"`
	ValidityNs          int64     `json:"validityNs"`
}

func parsePolicy(raw []byte) (policy, clock.Config, error) {
	var p policy
	var c clock.Config
	d := json.NewDecoder(bytes.NewReader(raw))
	tok, e := d.Token()
	if e != nil || tok != json.Delim('{') {
		return p, c, errors.New("invalid policy")
	}
	seen := map[string]bool{}
	for d.More() {
		key, e := d.Token()
		if e != nil {
			return p, c, e
		}
		k, ok := key.(string)
		if !ok || seen[k] {
			return p, c, errors.New("duplicate policy key")
		}
		switch k {
		case "sources", "socks", "earliest", "latest", "maxStepNs", "maxSpreadNs", "timeoutNs", "maxUncertaintyNs", "decisionTTLNs", "applyBudgetNs", "readbackToleranceNs", "validityNs":
		default:
			return p, c, errors.New("unknown policy key")
		}
		seen[k] = true
		var value json.RawMessage
		if e = d.Decode(&value); e != nil {
			return p, c, e
		}
		if k == "sources" {
			var sources []string
			if e = json.Unmarshal(value, &sources); e != nil || len(sources) != 3 {
				return p, c, errors.New("exactly three sources required")
			}
		}
	}
	if _, e = d.Token(); e != nil {
		return p, c, e
	}
	if _, e = d.Token(); e != io.EOF {
		return p, c, errors.New("policy trailing content")
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e = d.Decode(&p); e != nil {
		return p, c, e
	}
	earliest, e := time.Parse(time.RFC3339Nano, p.Earliest)
	if e != nil {
		return p, c, e
	}
	latest, e := time.Parse(time.RFC3339Nano, p.Latest)
	if e != nil {
		return p, c, e
	}
	c = clock.Config{Sources: p.Sources, SOCKS: p.SOCKS, Earliest: earliest, Latest: latest, MaxStep: time.Duration(p.MaxStepNs), MaxSpread: time.Duration(p.MaxSpreadNs), Timeout: time.Duration(p.TimeoutNs), MaxUncertainty: time.Duration(p.MaxUncertaintyNs), DecisionTTL: time.Duration(p.DecisionTTLNs)}
	if p.ApplyBudgetNs <= 0 || p.ApplyBudgetNs > int64(time.Second) || p.ReadbackToleranceNs <= 0 || p.ReadbackToleranceNs > int64(time.Second) || p.ValidityNs <= 0 || p.ValidityNs > int64(time.Hour) {
		return p, c, errors.New("invalid apply/validity bounds")
	}
	_, e = clock.New(c)
	return p, c, e
}
func trustedChain(path string) error {
	for p := filepath.Clean(path); ; p = filepath.Dir(p) {
		s, e := os.Lstat(p)
		if e != nil {
			return e
		}
		st := s.Sys().(*syscall.Stat_t)
		if !s.IsDir() || s.Mode()&os.ModeSymlink != 0 || st.Uid != 0 || st.Gid != 0 || s.Mode().Perm()&0022 != 0 {
			return errors.New("untrusted directory")
		}
		if p == "/" {
			break
		}
	}
	return nil
}
func regular(fd *os.File, path string, mode os.FileMode) error {
	s, e := fd.Stat()
	if e != nil {
		return e
	}
	named, e := os.Lstat(path)
	if e != nil {
		return e
	}
	st := s.Sys().(*syscall.Stat_t)
	if !s.Mode().IsRegular() || s.Mode().Perm() != mode || st.Uid != 0 || st.Gid != 0 || st.Nlink != 1 || !os.SameFile(s, named) {
		return errors.New("untrusted file identity")
	}
	return nil
}
func openRegular(path string, mode os.FileMode, flags int) (*os.File, error) {
	if e := trustedChain(filepath.Dir(path)); e != nil {
		return nil, e
	}
	fd, e := syscall.Open(path, flags|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, uint32(mode))
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), path)
	if e = regular(f, path, mode); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func readPolicy(path string) (policy, clock.Config, error) {
	f, e := openRegular(path, 0600, syscall.O_RDONLY)
	if e != nil {
		return policy{}, clock.Config{}, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, 8193))
	if e != nil || len(raw) > 8192 {
		return policy{}, clock.Config{}, errors.New("policy read bound")
	}
	return parsePolicy(raw)
}
func acquire(path string) (*os.File, error) {
	f, e := openRegular(path, 0600, syscall.O_RDWR|syscall.O_CREAT)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, e
	}
	if e = regular(f, path, 0600); e != nil {
		f.Close()
		return nil, e
	}
	return f, nil
}
func revoke(path string) error {
	f, e := openRegular(path, 0644, syscall.O_RDONLY)
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	defer f.Close()
	if e = regular(f, path, 0644); e != nil {
		return e
	}
	return os.Remove(path)
}
func boot() (time.Duration, error) {
	var t syscall.Timespec
	_, _, e := syscall.RawSyscall(syscall.SYS_CLOCK_GETTIME, 7, uintptr(unsafe.Pointer(&t)), 0)
	if e != 0 {
		return 0, e
	}
	return time.Duration(t.Nano()), nil
}
func setClock(utc time.Time) error {
	t := syscall.Timespec{Sec: utc.Unix(), Nsec: int64(utc.Nanosecond())}
	_, _, e := syscall.RawSyscall(syscall.SYS_CLOCK_SETTIME, 0, uintptr(unsafe.Pointer(&t)), 0)
	if e != 0 {
		return e
	}
	return nil
}
func bootID() (string, error) {
	raw, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if e != nil || len(raw) != 37 {
		return "", errors.New("boot identity unavailable")
	}
	s := strings.TrimSpace(string(raw))
	for i, ch := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if ch != '-' {
				return "", errors.New("boot identity")
			}
		} else if !strings.ContainsRune("0123456789abcdef", ch) {
			return "", errors.New("boot identity")
		}
	}
	return s, nil
}
func publish(path string, r receipt) error {
	raw, e := json.Marshal(r)
	if e != nil || len(raw) > 2048 {
		return errors.New("receipt bound")
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".ready-")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	if e = f.Chmod(0644); e != nil {
		return e
	}
	if _, e = f.Write(append(raw, '\n')); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	// Existing readiness was already revoked; never overwrite an unexpected path.
	if _, e = os.Lstat(path); !os.IsNotExist(e) {
		return errors.New("unexpected readiness path")
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	dir, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer dir.Close()
	return dir.Sync()
}
func prepareReadyDir(path string) error {
	if e := trustedChain(filepath.Dir(path)); e != nil {
		return e
	}
	if e := os.Mkdir(path, 0755); e == nil {
		if e = os.Chmod(path, 0755); e != nil {
			return e
		}
	} else if !os.IsExist(e) {
		return e
	}
	s, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !s.IsDir() || s.Mode().Perm() != 0755 {
		return errors.New("ready directory mode")
	}
	return trustedChain(path)
}
func main() {
	os.Unsetenv("SSL_CERT_FILE")
	os.Unsetenv("SSL_CERT_DIR")
	if len(os.Args) != 1 || os.Getuid() != 0 {
		fmt.Fprintln(os.Stderr, "clock correction refused")
		os.Exit(1)
	}
	if e := trustedChain("/run"); e != nil {
		fmt.Fprintln(os.Stderr, "clock correction unavailable")
		os.Exit(1)
	}
	var fs syscall.Statfs_t
	if e := syscall.Statfs("/run", &fs); e != nil || fs.Type != 0x01021994 {
		fmt.Fprintln(os.Stderr, "clock RAM state unavailable")
		os.Exit(1)
	}
	if e := prepareReadyDir(readyDir); e != nil {
		fmt.Fprintln(os.Stderr, "clock correction unavailable")
		os.Exit(1)
	}
	var e error
	if e = revoke(readyPath); e != nil {
		fmt.Fprintln(os.Stderr, "clock readiness revocation refused")
		os.Exit(1)
	}
	p, c, e := readPolicy(configPath)
	if e != nil {
		fmt.Fprintln(os.Stderr, "clock policy unavailable")
		os.Exit(1)
	}
	poller, e := clock.New(c)
	if e != nil {
		fmt.Fprintln(os.Stderr, "clock policy refused")
		os.Exit(1)
	}
	ops := operations{now: time.Now, boot: boot, bootID: bootID, set: setClock, poll: func(ctx context.Context, t time.Time) (consumable, error) { return poller.Poll(ctx, t) }, revoke: func() error { return revoke(readyPath) }, lock: func() (*os.File, error) { return acquire(lockPath) }, checkLock: func(f *os.File) error { return regular(f, lockPath, 0600) }, publish: func(r receipt) error { return publish(readyPath, r) }}
	if e = correct(context.Background(), p, ops); e != nil {
		fmt.Fprintln(os.Stderr, "clock correction unknown: "+strconv.Quote(e.Error()))
		os.Exit(1)
	}
}
