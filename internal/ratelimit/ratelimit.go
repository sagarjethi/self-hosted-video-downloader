// Package ratelimit is a tiny in-memory per-IP limiter. Self-hosted single
// instance — keeps a runaway client (or a shared link) from spawning
// unlimited downloads. Tune via env.
package ratelimit

import (
	"cmp"
	"os"
	"slices"
	"strconv"
	"sync"
	"time"
)

const window = 5 * time.Minute

// Limiter tracks download starts and concurrent downloads per IP.
type Limiter struct {
	mu            sync.Mutex
	maxPerWindow  int
	maxConcurrent int
	hits          map[string][]time.Time
	active        map[string]int
	now           func() time.Time // injectable for tests
}

func New() *Limiter {
	return &Limiter{
		maxPerWindow:  envInt("RATE_MAX_PER_WINDOW", 10),
		maxConcurrent: envInt("RATE_MAX_CONCURRENT", 3),
		hits:          make(map[string][]time.Time),
		active:        make(map[string]int),
		now:           time.Now,
	}
}

func envInt(key string, fallback int) int {
	if n, err := strconv.Atoi(cmp.Or(os.Getenv(key), "")); err == nil {
		return n
	}
	return fallback
}

// Check records a download attempt. The reason is user-facing when not ok.
func (l *Limiter) Check(ip string) (ok bool, reason string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := l.now()
	recent := slices.DeleteFunc(l.hits[ip], func(t time.Time) bool {
		return now.Sub(t) >= window
	})
	if len(recent) >= l.maxPerWindow {
		l.hits[ip] = recent
		return false, "Too many downloads. Try again in a few minutes."
	}
	if l.active[ip] >= l.maxConcurrent {
		l.hits[ip] = recent
		return false, "Too many downloads running at once. Wait for them to finish."
	}
	l.hits[ip] = append(recent, now)
	return true, ""
}

// MarkActive adjusts the concurrent-download count for an IP.
func (l *Limiter) MarkActive(ip string, delta int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.active[ip] = max(0, l.active[ip]+delta)
}
