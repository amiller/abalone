// SPDX-License-Identifier: MIT
package main

import (
	"context"
	"errors"
	"os"
	clock "portable-clock/posttor"
	"time"
)

type consumable interface {
	Consume() (clock.Application, error)
}
type receipt struct {
	Version          int    `json:"version"`
	State            string `json:"state"`
	BootID           string `json:"bootId"`
	AppliedUTC       string `json:"appliedUTC"`
	AppliedBootNs    int64  `json:"appliedBootNs"`
	UncertaintyNs    int64  `json:"uncertaintyNs"`
	ValidUntilBootNs int64  `json:"validUntilBootNs"`
}

// Internal test seams are never selected by arguments, environment, config or IPC.
type operations struct {
	now       func() time.Time
	boot      func() (time.Duration, error)
	bootID    func() (string, error)
	set       func(time.Time) error
	poll      func(context.Context, time.Time) (consumable, error)
	revoke    func() error
	lock      func() (*os.File, error)
	checkLock func(*os.File) error
	publish   func(receipt) error
}

func correct(ctx context.Context, p policy, o operations) (err error) {
	if err = o.revoke(); err != nil {
		return err
	}
	lock, err := o.lock()
	if err != nil {
		return errors.New("financial lifecycle busy or unavailable")
	}
	defer lock.Close()
	success := false
	defer func() {
		if !success {
			if e := o.revoke(); e != nil {
				err = errors.Join(err, e)
			}
		}
	}()
	id, err := o.bootID()
	if err != nil {
		return err
	}
	reference, err := sampleWall(o, p)
	if err != nil {
		return err
	}
	decision, err := o.poll(ctx, reference.wall)
	if err != nil {
		return err
	}
	started, err := o.boot()
	if err != nil {
		return err
	}
	app, err := decision.Consume()
	if err != nil {
		return err
	}
	consumedEnd, err := o.boot()
	if err != nil {
		return err
	}
	if consumedEnd < started {
		return errors.New("consume clock regressed")
	}
	consumeDuration := consumedEnd - started
	available := app.Remaining - consumeDuration
	budget := time.Duration(p.ApplyBudgetNs)
	if available < budget {
		budget = available
	}
	if budget <= 0 {
		return errors.New("application expired during consume")
	}
	if err = o.checkLock(lock); err != nil {
		return err
	}
	fresh, err := sampleWall(o, p)
	if err != nil {
		return err
	}
	before := fresh.end
	if ctx.Err() != nil || before < consumedEnd || before-consumedEnd >= budget {
		return errors.New("application expired")
	}
	// Consume already advances UTC. Its internal exact sampling instant lies
	// within [started,consumedEnd]; do not advance it by that interval again.
	target := app.UTC.Add(before - consumedEnd)
	preUncertainty := app.Uncertainty + consumeDuration + budget
	if preUncertainty > time.Duration(p.MaxUncertaintyNs) {
		return errors.New("pre-apply uncertainty exceeds policy")
	}
	if err = reference.check(target, preUncertainty, before, p); err != nil {
		return err
	}
	if err = fresh.check(target, preUncertainty, before, p); err != nil {
		return err
	}
	// One syscall in production; never retry even when error cannot prove no step.
	if err = o.set(target); err != nil {
		return errors.New("clock set outcome unknown")
	}
	observed := o.now()
	finished, err := o.boot()
	if err != nil {
		return err
	}
	if finished < before || finished-consumedEnd >= budget {
		return errors.New("readback expired")
	}
	expected := target.Add(finished - before)
	difference := observed.Sub(expected)
	if difference < 0 {
		difference = -difference
	}
	if difference > time.Duration(p.ReadbackToleranceNs) {
		return errors.New("clock readback mismatch")
	}
	uncertainty := app.Uncertainty + consumeDuration + (finished - consumedEnd) + difference
	if uncertainty > time.Duration(p.MaxUncertaintyNs) {
		return errors.New("application uncertainty exceeds policy")
	}
	if err = reference.check(observed, uncertainty, finished, p); err != nil {
		return err
	}
	if err = fresh.check(observed, uncertainty, finished, p); err != nil {
		return err
	}
	afterID, err := o.bootID()
	if err != nil || afterID != id {
		return errors.New("boot identity changed")
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	latest, e := time.Parse(time.RFC3339Nano, p.Latest)
	if e != nil {
		return e
	}
	validity := time.Duration(p.ValidityNs)
	if margin := latest.Sub(observed.Add(uncertainty)); margin < validity {
		validity = margin
	}
	if validity <= 0 {
		return errors.New("clock readiness has no remaining policy lifetime")
	}
	r := receipt{Version: 1, State: "qualified", BootID: id, AppliedUTC: observed.UTC().Format(time.RFC3339Nano), AppliedBootNs: int64(finished), UncertaintyNs: int64(uncertainty), ValidUntilBootNs: int64(finished) + int64(validity)}
	if err = o.publish(r); err != nil {
		return err
	}
	success = true
	return nil
}

func applicationBounds(target time.Time, uncertainty time.Duration, reference time.Time, p policy) error {
	earliest, e := time.Parse(time.RFC3339Nano, p.Earliest)
	if e != nil {
		return e
	}
	latest, e := time.Parse(time.RFC3339Nano, p.Latest)
	if e != nil {
		return e
	}
	lower, upper := target.Add(-uncertainty), target.Add(uncertainty)
	if lower.Before(earliest) || upper.After(latest) || lower.Before(reference.Add(-time.Duration(p.MaxStepNs))) || upper.After(reference.Add(time.Duration(p.MaxStepNs))) {
		return errors.New("application uncertainty outside policy")
	}
	return nil
}

type wallSample struct {
	wall       time.Time
	start, end time.Duration
}

func sampleWall(o operations, p policy) (wallSample, error) {
	start, e := o.boot()
	if e != nil {
		return wallSample{}, e
	}
	wall := o.now()
	end, e := o.boot()
	if e != nil {
		return wallSample{}, e
	}
	limit := time.Duration(p.ApplyBudgetNs)
	if time.Duration(p.ReadbackToleranceNs) < limit {
		limit = time.Duration(p.ReadbackToleranceNs)
	}
	if end < start || end-start > limit {
		return wallSample{}, errors.New("wall reference sampling expired")
	}
	return wallSample{wall, start, end}, nil
}
func (s wallSample) check(target time.Time, uncertainty time.Duration, at time.Duration, p policy) error {
	if at < s.end {
		return errors.New("reference clock regressed")
	}
	// The wall read occurred somewhere inside the BOOTTIME bracket. Require
	// admission for both endpoints, not an assumed zero-duration sample.
	if e := applicationBounds(target, uncertainty, s.wall.Add(at-s.end), p); e != nil {
		return e
	}
	return applicationBounds(target, uncertainty, s.wall.Add(at-s.start), p)
}
