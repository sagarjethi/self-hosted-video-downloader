package api

import (
	"net/http/httptest"
	"testing"
)

func TestParseSection(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	cases := []struct {
		name      string
		req       createJobRequest
		wantNil   bool
		wantErr   bool
		wantStart int
		wantEnd   int
	}{
		{name: "absent", req: createJobRequest{}, wantNil: true},
		{name: "valid", req: createJobRequest{Start: f(100), End: f(160)}, wantStart: 100, wantEnd: 160},
		{name: "fractional", req: createJobRequest{Start: f(10.7), End: f(20.2)}, wantStart: 10, wantEnd: 21},
		{name: "start only", req: createJobRequest{Start: f(10)}, wantErr: true},
		{name: "end before start", req: createJobRequest{Start: f(100), End: f(50)}, wantErr: true},
		{name: "negative start", req: createJobRequest{Start: f(-1), End: f(50)}, wantErr: true},
		{name: "too long", req: createJobRequest{Start: f(0), End: f(5 * 3600)}, wantErr: true},
		{name: "end without start ok", req: createJobRequest{End: f(60)}, wantStart: 0, wantEnd: 60},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sec, err := parseSection(c.req)
			if c.wantErr {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if c.wantNil {
				if sec != nil {
					t.Fatal("expected nil section")
				}
				return
			}
			if sec.Start != c.wantStart || sec.End != c.wantEnd {
				t.Fatalf("got %d-%d, want %d-%d", sec.Start, sec.End, c.wantStart, c.wantEnd)
			}
		})
	}
}

func TestValidURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://youtube.com/watch?v=x", true},
		{"http://example.com", true},
		{"ftp://example.com", false},
		{"not a url", false},
		{"", false},
	}
	for _, c := range cases {
		if got := validURL(c.url); got != c.want {
			t.Errorf("validURL(%q) = %v, want %v", c.url, got, c.want)
		}
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	if got := clientIP(r); got != "local" {
		t.Errorf("no headers: got %q, want local", got)
	}
	r.Header.Set("X-Real-Ip", "9.9.9.9")
	if got := clientIP(r); got != "9.9.9.9" {
		t.Errorf("x-real-ip: got %q", got)
	}
	r.Header.Set("X-Forwarded-For", "1.2.3.4, 5.6.7.8")
	if got := clientIP(r); got != "1.2.3.4" {
		t.Errorf("xff: got %q", got)
	}
}
