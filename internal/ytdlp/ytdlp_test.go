package ytdlp

import (
	"slices"
	"strings"
	"testing"
)

func TestFmtDuration(t *testing.T) {
	cases := []struct {
		secs float64
		want string
	}{
		{0, ""},
		{26.292, "0:26"},
		{90, "1:30"},
		{3600, "1:00:00"},
		{12460, "3:27:40"},
	}
	for _, c := range cases {
		if got := FmtDuration(c.secs); got != c.want {
			t.Errorf("FmtDuration(%v) = %q, want %q", c.secs, got, c.want)
		}
	}
}

func TestBuildDownloadArgsVideo(t *testing.T) {
	args := BuildDownloadArgs("https://example.com/v", TypeVideo, "720", "/tmp/x", nil)
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"--no-playlist",
		"--restrict-filenames",
		"-f bv*[height<=720]+ba/b[height<=720]/b",
		"--merge-output-format mp4",
		"https://example.com/v",
	} {
		if !strings.Contains(joined, want) {
			t.Errorf("video args missing %q in %q", want, joined)
		}
	}
	if strings.Contains(joined, "--download-sections") {
		t.Error("video args should not contain a section when none given")
	}
}

func TestBuildDownloadArgsAudio(t *testing.T) {
	args := BuildDownloadArgs("u", TypeAudio, "mp3", "/tmp/x", nil)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-x --audio-format mp3") {
		t.Errorf("audio args missing extraction flags: %q", joined)
	}
}

func TestBuildDownloadArgsSection(t *testing.T) {
	args := BuildDownloadArgs("u", TypeVideo, "best", "/tmp/x", &Section{Start: 7760, End: 7930})
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--download-sections *7760-7930") {
		t.Errorf("section args wrong: %q", joined)
	}
	if !slices.Contains(args, "--force-keyframes-at-cuts") {
		t.Error("section args missing --force-keyframes-at-cuts")
	}
}

func TestCleanErrorFriendlyMapping(t *testing.T) {
	cases := []struct {
		stderr string
		want   string
	}{
		{
			"ERROR: [Instagram] x: Instagram sent an empty media response. Check if this post is accessible.",
			"This post needs a logged-in session",
		},
		{
			"ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate.",
			"This video is age-restricted",
		},
		{
			"ERROR: [youtube] x: Private video. Sign in if you've been granted access.",
			"This video is private",
		},
		{
			"ERROR: [youtube] x: Video unavailable",
			"Video unavailable",
		},
		{
			"ERROR: Unsupported URL: https://example.com",
			"This link type isn't supported.",
		},
	}
	for _, c := range cases {
		if got := cleanError(c.stderr); !strings.HasPrefix(got, c.want) {
			t.Errorf("cleanError(%q) = %q, want prefix %q", c.stderr, got, c.want)
		}
	}
}

func TestCleanErrorTrimsBoilerplate(t *testing.T) {
	got := cleanError("ERROR: something odd happened. See https://github.com/yt-dlp for how to fix")
	if strings.Contains(got, "github.com") {
		t.Errorf("boilerplate not trimmed: %q", got)
	}
}
