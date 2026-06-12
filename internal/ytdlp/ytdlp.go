// Package ytdlp wraps the yt-dlp binary: metadata probing, downloads with
// progress reporting, optional cut sections, cookie auth, and mapping of
// yt-dlp's wall-of-text errors to short actionable messages.
package ytdlp

import (
	"bufio"
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// DownloadType selects the output kind.
type DownloadType string

const (
	TypeVideo DownloadType = "video"
	TypeAudio DownloadType = "audio"
)

// Section is an optional cut range in seconds (start inclusive, end exclusive).
type Section struct {
	Start int
	End   int
}

// MediaInfo is the probe result. JSON field names match the existing API
// contract consumed by the React UI — do not rename.
type MediaInfo struct {
	Title        string  `json:"title"`
	Thumbnail    *string `json:"thumbnail"`
	Duration     float64 `json:"duration"`
	DurationText string  `json:"durationText"`
	Uploader     *string `json:"uploader"`
	Extractor    string  `json:"extractor"`
	WebpageURL   string  `json:"webpageUrl"`
	IsLive       bool    `json:"isLive"`
}

// Progress is one parsed yt-dlp progress line.
type Progress struct {
	Percent float64
	Speed   string
	Eta     string
}

func binPath() string {
	return cmp.Or(os.Getenv("YTDLP_PATH"), "yt-dlp")
}

// cookieArgs returns optional authentication flags for gated content
// (Instagram reels, age-restricted or members-only videos). Set ONE of:
//
//	YTDLP_COOKIES         — path to a Netscape cookies.txt export
//	YTDLP_COOKIES_BROWSER — browser to read cookies from (chrome|safari|firefox|edge)
func cookieArgs() []string {
	if p := os.Getenv("YTDLP_COOKIES"); p != "" {
		return []string{"--cookies", p}
	}
	if b := os.Getenv("YTDLP_COOKIES_BROWSER"); b != "" {
		return []string{"--cookies-from-browser", b}
	}
	return nil
}

func hasAuth() bool {
	return os.Getenv("YTDLP_COOKIES") != "" || os.Getenv("YTDLP_COOKIES_BROWSER") != ""
}

// FmtDuration renders seconds as "m:ss" or "h:mm:ss"; empty for unknown/live.
func FmtDuration(secs float64) string {
	if secs <= 0 || math.IsNaN(secs) || math.IsInf(secs, 0) {
		return ""
	}
	s := int(math.Round(secs))
	h, m, ss := s/3600, (s%3600)/60, s%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, ss)
	}
	return fmt.Sprintf("%d:%02d", m, ss)
}

var bracketRe = regexp.MustCompile(`\s*\[.*?\]\s*`)

// cleanError extracts the last "ERROR:" line from stderr, strips bracketed
// tags, and maps it to a friendly message.
func cleanError(stderr string) string {
	var last string
	for line := range strings.SplitSeq(stderr, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ERROR:") {
			last = line
		}
	}
	if last == "" {
		return ""
	}
	raw := strings.TrimPrefix(last, "ERROR:")
	raw = strings.TrimSpace(bracketRe.ReplaceAllString(raw, " "))
	return friendlyError(raw)
}

// friendlyError maps yt-dlp errors to short, actionable messages.
func friendlyError(raw string) string {
	lower := strings.ToLower(raw)
	authHint := "This server has no login cookies configured. Set YTDLP_COOKIES_BROWSER=chrome (or YTDLP_COOKIES=/path/to/cookies.txt) and restart."
	if hasAuth() {
		authHint = "The configured cookies may be expired — refresh them and restart."
	}

	switch {
	case strings.Contains(lower, "empty media response"),
		strings.Contains(lower, "login required"),
		strings.Contains(lower, "requested content is not available"),
		strings.Contains(lower, "rate-limit reached"):
		return "This post needs a logged-in session (common for Instagram). " + authHint
	case strings.Contains(lower, "sign in to confirm your age"),
		strings.Contains(lower, "age-restricted"):
		return "This video is age-restricted. " + authHint
	case strings.Contains(lower, "private video"),
		strings.Contains(lower, "this video is private"):
		return "This video is private — it can only be downloaded by an account that has access."
	case strings.Contains(lower, "video unavailable"),
		strings.Contains(lower, "404"):
		return "Video unavailable — it may have been removed or the link is wrong."
	case strings.Contains(lower, "unsupported url"):
		return "This link type isn't supported."
	}
	// Keep unknown errors but trim the boilerplate yt-dlp appends.
	msg, _, _ := strings.Cut(raw, ". See ")
	msg, _, _ = strings.Cut(msg, " Otherwise,")
	return strings.TrimSpace(msg)
}

var errNotInstalled = errors.New("yt-dlp is not installed on the server.")

// Probe fetches title/thumbnail/duration for a URL without downloading.
func Probe(ctx context.Context, url string) (*MediaInfo, error) {
	args := []string{"-J", "--no-playlist", "--no-warnings", "--playlist-items", "1"}
	args = append(args, cookieArgs()...)
	args = append(args, url)

	cmd := exec.CommandContext(ctx, binPath(), args...)
	var out, errBuf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errBuf
	if err := cmd.Run(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, errNotInstalled
		}
		if msg := cleanError(errBuf.String()); msg != "" {
			return nil, errors.New(msg)
		}
		return nil, fmt.Errorf("yt-dlp failed: %w", err)
	}

	var j map[string]any
	if err := json.Unmarshal(out.Bytes(), &j); err != nil {
		return nil, fmt.Errorf("parse yt-dlp output: %w", err)
	}
	meta := j
	if entries, ok := j["entries"].([]any); ok && len(entries) > 0 {
		if first, ok := entries[0].(map[string]any); ok {
			meta = first
		}
	}

	duration, _ := meta["duration"].(float64)
	info := &MediaInfo{
		Title:        cmp.Or(str(meta, "title"), str(meta, "id"), "Untitled"),
		Thumbnail:    strPtr(meta, "thumbnail"),
		Duration:     duration,
		DurationText: FmtDuration(duration),
		Uploader:     firstPtr(meta, "uploader", "channel", "uploader_id"),
		Extractor:    strings.ToLower(cmp.Or(str(meta, "extractor_key"), str(meta, "extractor"))),
		WebpageURL:   cmp.Or(str(meta, "webpage_url"), url),
	}
	info.IsLive, _ = meta["is_live"].(bool)
	return info, nil
}

func str(m map[string]any, key string) string {
	s, _ := m[key].(string)
	return s
}

func strPtr(m map[string]any, key string) *string {
	if s, ok := m[key].(string); ok && s != "" {
		return &s
	}
	return nil
}

func firstPtr(m map[string]any, keys ...string) *string {
	for _, k := range keys {
		if p := strPtr(m, k); p != nil {
			return p
		}
	}
	return nil
}

// BuildDownloadArgs assembles the yt-dlp argument list for a download into dir.
func BuildDownloadArgs(url string, typ DownloadType, quality, dir string, section *Section) []string {
	outTemplate := filepath.Join(dir, "%(title).80B [%(id)s].%(ext)s")
	args := []string{
		"--no-playlist",
		"--no-warnings",
		"--restrict-filenames",
		"--no-part",
		"-o", outTemplate,
		"--newline",
		"--progress-template",
		"DLP|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
	}

	// Cut: fetch only the selected range and re-keyframe at the cut points so
	// the clip starts cleanly instead of freezing until the next keyframe.
	if section != nil {
		args = append(args,
			"--download-sections", fmt.Sprintf("*%d-%d", section.Start, section.End),
			"--force-keyframes-at-cuts",
		)
	}
	args = append(args, cookieArgs()...)

	if typ == TypeAudio {
		format := "m4a"
		if quality == "mp3" {
			format = "mp3"
		}
		return append(args, "-f", "ba/b", "-x", "--audio-format", format, url)
	}

	format := "bv*+ba/b"
	if quality != "best" {
		if h, err := strconv.Atoi(quality); err == nil {
			format = fmt.Sprintf("bv*[height<=%d]+ba/b[height<=%d]/b", h, h)
		}
	}
	return append(args, "-f", format, "--merge-output-format", "mp4", url)
}

// Run is a download in flight. Cancel kills the process; Wait blocks until it
// settles and returns the final file path.
type Run struct {
	cmd    *exec.Cmd
	done   chan struct{}
	path   string
	runErr error
}

// StartDownload spawns yt-dlp. onProgress is called from a background
// goroutine as progress lines arrive.
func StartDownload(url string, typ DownloadType, quality, dir string, section *Section, onProgress func(Progress)) (*Run, error) {
	cmd := exec.Command(binPath(), BuildDownloadArgs(url, typ, quality, dir, section)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf

	if err := cmd.Start(); err != nil {
		if errors.Is(err, exec.ErrNotFound) {
			return nil, errNotInstalled
		}
		return nil, err
	}

	r := &Run{cmd: cmd, done: make(chan struct{})}
	go func() {
		defer close(r.done)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			rest, ok := strings.CutPrefix(line, "DLP|")
			if !ok {
				continue
			}
			parts := strings.Split(rest, "|")
			if len(parts) < 3 {
				continue
			}
			pct, _ := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(parts[0]), "%")), 64)
			if math.IsNaN(pct) || math.IsInf(pct, 0) {
				pct = 0
			}
			onProgress(Progress{Percent: pct, Speed: strings.TrimSpace(parts[1]), Eta: strings.TrimSpace(parts[2])})
		}

		if err := cmd.Wait(); err != nil {
			if msg := cleanError(errBuf.String()); msg != "" {
				r.runErr = errors.New(msg)
			} else {
				r.runErr = fmt.Errorf("download failed: %w", err)
			}
			return
		}
		r.path, r.runErr = newestFile(dir)
	}()
	return r, nil
}

// Cancel kills the yt-dlp process (SIGKILL, matching the Node implementation).
func (r *Run) Cancel() {
	if r.cmd.Process != nil {
		_ = r.cmd.Process.Kill()
	}
}

// Wait blocks until the download settles.
func (r *Run) Wait() (string, error) {
	<-r.done
	return r.path, r.runErr
}

var fragmentRe = regexp.MustCompile(`\.f\d+\.`)

// newestFile picks the largest finished file in dir (skips temp fragments).
func newestFile(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var best string
	var bestSize int64 = -1
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".part") || strings.HasSuffix(name, ".ytdl") || fragmentRe.MatchString(name) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if info.Size() > bestSize {
			bestSize = info.Size()
			best = filepath.Join(dir, name)
		}
	}
	if best == "" {
		return "", errors.New("No output file was produced.")
	}
	return best, nil
}
