// Package api wires the HTTP routes. The JSON contract matches the original
// Node implementation exactly so the React UI works unchanged.
package api

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/sagarjethi/self-hosted-video-downloader/internal/jobs"
	"github.com/sagarjethi/self-hosted-video-downloader/internal/ratelimit"
	"github.com/sagarjethi/self-hosted-video-downloader/internal/ytdlp"
)

const (
	probeTimeout  = 90 * time.Second
	maxURLLen     = 2048
	maxCutSeconds = 4 * 3600
)

// Server holds the handler dependencies.
type Server struct {
	jobs    *jobs.Store
	limiter *ratelimit.Limiter
	ui      fs.FS // built React app (index.html at the root)
}

func New(store *jobs.Store, limiter *ratelimit.Limiter, ui fs.FS) *Server {
	return &Server{jobs: store, limiter: limiter, ui: ui}
}

// Handler builds the route table.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/info", s.handleInfo)
	mux.HandleFunc("POST /api/jobs", s.handleCreateJob)
	mux.HandleFunc("GET /api/jobs/{id}", s.handleGetJob)
	mux.HandleFunc("DELETE /api/jobs/{id}", s.handleCancelJob)
	mux.HandleFunc("GET /api/jobs/{id}/file", s.handleJobFile)
	mux.HandleFunc("GET /api/thumb", s.handleThumb)
	mux.Handle("/", s.spaHandler())
	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// clientIP mirrors the Node implementation: first X-Forwarded-For hop,
// then X-Real-Ip, else "local".
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if ip := strings.TrimSpace(first); ip != "" {
			return ip
		}
	}
	return cmp.Or(r.Header.Get("X-Real-Ip"), "local")
}

func validURL(raw string) bool {
	if raw == "" || len(raw) > maxURLLen {
		return false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if !validURL(body.URL) {
		writeError(w, http.StatusBadRequest, "Enter a valid http(s) link.")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), probeTimeout)
	defer cancel()
	info, err := ytdlp.Probe(ctx, body.URL)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, info)
}

type createJobRequest struct {
	URL     string   `json:"url"`
	Type    string   `json:"type"`
	Quality string   `json:"quality"`
	Start   *float64 `json:"start"`
	End     *float64 `json:"end"`
}

// parseSection validates an optional cut range. Mirrors the Node rules:
// start >= 0, end > start, span <= 4h.
func parseSection(req createJobRequest) (*ytdlp.Section, error) {
	if req.Start == nil && req.End == nil {
		return nil, nil
	}
	start := 0.0
	if req.Start != nil {
		start = *req.Start
	}
	if req.End == nil {
		return nil, errors.New("Invalid cut range.")
	}
	end := *req.End
	if start < 0 || end <= start || end-start > maxCutSeconds {
		return nil, errors.New("Invalid cut range.")
	}
	return &ytdlp.Section{Start: int(math.Floor(start)), End: int(math.Ceil(end))}, nil
}

func (s *Server) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	var req createJobRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	if !validURL(req.URL) {
		writeError(w, http.StatusBadRequest, "Enter a valid http(s) link.")
		return
	}

	typ := ytdlp.TypeVideo
	if req.Type == "audio" {
		typ = ytdlp.TypeAudio
	}
	quality := req.Quality
	if quality == "" {
		quality = "best"
		if typ == ytdlp.TypeAudio {
			quality = "m4a"
		}
	}

	section, err := parseSection(req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	ip := clientIP(r)
	if ok, reason := s.limiter.Check(ip); !ok {
		writeError(w, http.StatusTooManyRequests, reason)
		return
	}

	s.limiter.MarkActive(ip, 1)
	// Store.Start always invokes onSettle exactly once, even when it errors.
	view, err := s.jobs.Start(req.URL, typ, quality, section, func() {
		s.limiter.MarkActive(ip, -1)
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, view)
}

func (s *Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	view, ok := s.jobs.Get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "Job not found or expired.")
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleCancelJob(w http.ResponseWriter, r *http.Request) {
	if !s.jobs.Cancel(r.PathValue("id")) {
		writeError(w, http.StatusConflict, "Job is not running.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

var contentTypes = map[string]string{
	".mp4":  "video/mp4",
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".webm": "video/webm",
}

func (s *Server) handleJobFile(w http.ResponseWriter, r *http.Request) {
	path, name, ok := s.jobs.FilePath(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "File not ready.")
		return
	}
	f, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusGone, "File expired. Please download again.")
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusGone, "File expired. Please download again.")
		return
	}

	ctype := "application/octet-stream"
	if i := strings.LastIndex(name, "."); i >= 0 {
		ctype = cmp.Or(contentTypes[strings.ToLower(name[i:])], ctype)
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	// ServeContent adds Content-Length and free Range support.
	http.ServeContent(w, r, "", info.ModTime(), f)
}

// spaHandler serves the embedded React build, falling back to index.html for
// client-side routes.
func (s *Server) spaHandler() http.Handler {
	fileServer := http.FileServerFS(s.ui)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p != "" {
			if _, err := fs.Stat(s.ui, p); err == nil {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFileFS(w, r, s.ui, "index.html")
	})
}
