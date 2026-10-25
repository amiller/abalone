// SPDX-License-Identifier: MIT
package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	clock "portable-clock/posttor"
	"strings"
	"syscall"
	"testing"
	"time"
)

type fixtureDecision struct {
	app     clock.Application
	err     error
	consume func()
}

func (d fixtureDecision) Consume() (clock.Application, error) {
	if d.consume != nil {
		d.consume()
	}
	return d.app, d.err
}
func TestTransactionRecordingSetter(t *testing.T) {
	for _, kind := range []string{"success", "busy", "expired", "readback", "set-error", "late", "publish", "lock-replaced", "delayed-consume", "near-latest", "clipped-ready", "zero-margin", "paused-reference", "fresh-wall-changed"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			lockName := filepath.Join(dir, "lifecycle")
			ready := filepath.Join(dir, "ready.json")
			os.WriteFile(ready, []byte("old"), 0644)
			os.Chmod(ready, 0644)
			lock, e := acquire(lockName)
			if e != nil {
				t.Fatal(e)
			}
			if kind != "busy" {
				lock.Close()
			} else {
				defer lock.Close()
			}
			base := time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC)
			wall := base
			stamp := time.Second
			sets := 0
			polls := 0
			published := false
			nowCalls := 0
			p := policy{Earliest: base.Add(-time.Hour).Format(time.RFC3339), Latest: base.Add(time.Hour).Format(time.RFC3339), MaxStepNs: int64(time.Hour), ApplyBudgetNs: int64(100 * time.Millisecond), ReadbackToleranceNs: int64(10 * time.Millisecond), MaxUncertaintyNs: int64(time.Second), ValidityNs: int64(time.Minute)}
			if kind == "paused-reference" || kind == "fresh-wall-changed" {
				p.MaxStepNs = int64(time.Minute)
			}
			if kind == "near-latest" {
				p.Latest = base.Add(5*time.Minute + 50*time.Millisecond).Format(time.RFC3339Nano)
			}
			if kind == "clipped-ready" {
				p.Latest = base.Add(5*time.Minute + time.Second).Format(time.RFC3339Nano)
			}
			if kind == "zero-margin" {
				p.Latest = base.Add(5*time.Minute + 206*time.Millisecond).Format(time.RFC3339Nano)
				p.ReadbackToleranceNs = int64(150 * time.Millisecond)
			}
			o := operations{now: func() time.Time {
				nowCalls++
				if kind == "paused-reference" && nowCalls == 1 {
					stamp += time.Hour
					return wall.Add(time.Hour)
				}
				if kind == "fresh-wall-changed" && nowCalls == 2 {
					return wall.Add(time.Hour)
				}
				return wall
			}, boot: func() (time.Duration, error) { stamp += time.Millisecond; return stamp, nil }, bootID: func() (string, error) { return "fixture-boot", nil }, revoke: func() error { return revoke(ready) }, lock: func() (*os.File, error) { return acquire(lockName) }, checkLock: func(f *os.File) error {
				if kind == "lock-replaced" {
					return errors.New("changed")
				}
				return regular(f, lockName, 0600)
			}, poll: func(context.Context, time.Time) (consumable, error) {
				polls++
				d := fixtureDecision{app: clock.Application{UTC: base.Add(5 * time.Minute), Uncertainty: time.Millisecond, Remaining: time.Second}}
				if kind == "fresh-wall-changed" {
					d.app.UTC = base
				}
				if kind == "expired" {
					d.err = errors.New("expired")
				}
				if kind == "delayed-consume" {
					d.app.UTC = d.app.UTC.Add(400 * time.Millisecond)
					d.consume = func() { stamp += 400 * time.Millisecond }
				}
				return d, nil
			}, set: func(target time.Time) error {
				sets++
				if kind == "delayed-consume" && target.After(base.Add(5*time.Minute+450*time.Millisecond)) {
					t.Fatal("Consume time counted twice", target)
				}
				wall = target
				if kind == "zero-margin" {
					wall = wall.Add(100 * time.Millisecond)
				}
				if kind == "readback" {
					wall = wall.Add(time.Hour)
				}
				if kind == "late" {
					stamp += time.Second
				}
				if kind == "set-error" {
					return errors.New("unknown")
				}
				return nil
			}, publish: func(r receipt) error {
				if kind == "publish" {
					return errors.New("write failed")
				}
				if kind == "clipped-ready" && (r.ValidUntilBootNs-r.AppliedBootNs >= int64(time.Second) || r.ValidUntilBootNs-r.AppliedBootNs <= 0) {
					t.Fatal("readiness exceeded Latest margin", r)
				}
				if r.BootID != "fixture-boot" || r.State != "qualified" || r.ValidUntilBootNs <= r.AppliedBootNs {
					t.Fatal(r)
				}
				if e := publish(ready, r); e != nil {
					return e
				}
				published = true
				return nil
			}}
			err := correct(context.Background(), p, o)
			if kind == "zero-margin" && (err == nil || !strings.Contains(err.Error(), "no remaining policy lifetime")) {
				t.Fatal("wrong zero-margin boundary", err)
			}
			if kind == "success" || kind == "delayed-consume" || kind == "clipped-ready" {
				if err != nil || sets != 1 || !published {
					t.Fatal(err, sets, published)
				}
			} else {
				if err == nil {
					t.Fatal("accepted", kind)
				}
				if _, e := os.Lstat(ready); !os.IsNotExist(e) {
					t.Fatal("ready survived failure", e)
				}
			}
			if (kind == "busy" || kind == "expired" || kind == "lock-replaced" || kind == "near-latest" || kind == "paused-reference" || kind == "fresh-wall-changed") && sets != 0 {
				t.Fatal("applied on refusal")
			}
			if (kind == "busy" || kind == "paused-reference") && polls != 0 {
				t.Fatal("polled while financial lock held")
			}
			if sets > 1 {
				t.Fatal("setter retried")
			}
		})
	}
}
func TestSharedFinancialLeaseBlocks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lifecycle")
	f, e := openRegular(path, 0600, syscall.O_RDWR|syscall.O_CREAT)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_SH|syscall.LOCK_NB); e != nil {
		t.Fatal(e)
	}
	if acquired, e := acquire(path); e == nil {
		acquired.Close()
		t.Fatal("exclusive lock admitted with shared lease")
	}
}
func TestRefuseForeignReadyAndUnsafeLock(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	os.WriteFile(target, []byte("preserve"), 0644)
	ready := filepath.Join(dir, "ready")
	os.Symlink(target, ready)
	if e := revoke(ready); e == nil {
		t.Fatal("symlink readiness removed")
	}
	data, _ := os.ReadFile(target)
	if string(data) != "preserve" {
		t.Fatal("target changed")
	}
	lock := filepath.Join(dir, "lock")
	os.WriteFile(lock, nil, 0666)
	os.Chmod(lock, 0666)
	if f, e := acquire(lock); e == nil {
		f.Close()
		t.Fatal("unsafe lock accepted")
	}
}
func TestStrictPolicy(t *testing.T) {
	for _, raw := range []string{`{}`, `{"socks":"x","socks":"y"}`, `{"unknown":true}`, `{"Sources":["a","b","c"]}`, `{"sources":["a","b","c","d"]}`} {
		if _, _, e := parsePolicy([]byte(raw)); e == nil {
			t.Fatal("bad policy admitted")
		}
	}
}

func TestReadyDirectoryUmask(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ready")
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	if e := prepareReadyDir(path); e != nil {
		t.Fatal(e)
	}
	s, _ := os.Stat(path)
	if s.Mode().Perm() != 0755 {
		t.Fatal(s.Mode())
	}
	os.Chmod(path, 0700)
	if e := prepareReadyDir(path); e == nil {
		t.Fatal("silently repaired existing unsafe directory")
	}
}
