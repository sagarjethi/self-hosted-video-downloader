package ratelimit

import (
	"testing"
	"time"
)

func newTest(perWindow, concurrent int) *Limiter {
	l := New()
	l.maxPerWindow = perWindow
	l.maxConcurrent = concurrent
	return l
}

func TestWindowLimit(t *testing.T) {
	l := newTest(2, 100)
	for i := range 2 {
		if ok, _ := l.Check("a"); !ok {
			t.Fatalf("check %d should pass", i)
		}
	}
	if ok, reason := l.Check("a"); ok || reason == "" {
		t.Fatal("third check within window should be rejected with a reason")
	}
	// Another IP is unaffected.
	if ok, _ := l.Check("b"); !ok {
		t.Fatal("different IP should pass")
	}
}

func TestWindowExpiry(t *testing.T) {
	l := newTest(1, 100)
	now := time.Now()
	l.now = func() time.Time { return now }
	if ok, _ := l.Check("a"); !ok {
		t.Fatal("first check should pass")
	}
	now = now.Add(window + time.Second)
	if ok, _ := l.Check("a"); !ok {
		t.Fatal("check after window expiry should pass")
	}
}

func TestConcurrentLimit(t *testing.T) {
	l := newTest(100, 1)
	l.MarkActive("a", 1)
	if ok, _ := l.Check("a"); ok {
		t.Fatal("concurrent limit should reject")
	}
	l.MarkActive("a", -1)
	if ok, _ := l.Check("a"); !ok {
		t.Fatal("after release should pass")
	}
	// Never goes negative.
	l.MarkActive("a", -5)
	l.MarkActive("a", 1)
	if ok, _ := l.Check("a"); ok {
		t.Fatal("active=1 with limit 1 should reject")
	}
}
