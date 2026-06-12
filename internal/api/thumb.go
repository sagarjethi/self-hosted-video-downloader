package api

import (
	"cmp"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

// thumbHosts is the proxy allowlist — only media-CDN hosts, to prevent SSRF.
var thumbHosts = []string{".cdninstagram.com", ".fbcdn.net", ".ytimg.com", ".googleusercontent.com"}

var thumbClient = &http.Client{Timeout: 15 * time.Second}

// handleThumb proxies media thumbnails that block cross-origin browser loads
// (Instagram CDN).
func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	target, err := url.Parse(r.URL.Query().Get("u"))
	if err != nil || target.Host == "" {
		writeError(w, http.StatusBadRequest, "Bad URL.")
		return
	}
	allowed := target.Scheme == "https" && slices.ContainsFunc(thumbHosts, func(h string) bool {
		return strings.HasSuffix(target.Hostname(), h)
	})
	if !allowed {
		writeError(w, http.StatusForbidden, "Host not allowed.")
		return
	}

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Bad URL.")
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")

	res, err := thumbClient.Do(req)
	if err != nil {
		writeError(w, http.StatusBadGateway, "Fetch failed.")
		return
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadGateway, "Upstream failed.")
		return
	}

	w.Header().Set("Content-Type", cmp.Or(res.Header.Get("Content-Type"), "image/jpeg"))
	w.Header().Set("Cache-Control", "public, max-age=600")
	_, _ = io.Copy(w, res.Body)
}
