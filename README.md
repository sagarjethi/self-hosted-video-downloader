# Downcut — YouTube & Instagram Downloader with Online Video Cutter

**Downcut** is a self-hosted web app that downloads YouTube videos and Instagram
reels — with a built-in **online video cutter**. Paste a link, preview the video,
optionally trim a section on the timeline, and download it as video (up to 4K)
or audio (M4A/MP3). One small server (UI + API) wrapping
[`yt-dlp`](https://github.com/yt-dlp/yt-dlp) + `ffmpeg`.

The cut is done server-side with `--download-sections`, so **only the selected
range is fetched** — cutting 30 seconds out of a 3-hour video downloads ~30
seconds, not 3 hours.

## Features

- 🎬 **YouTube & Instagram tabs** — paste any link; the right tab activates automatically
- ✂️ **Online video cutter** — drag two handles on a timeline or type exact times (`2:09:20`)
- 📥 **Video or audio** — BEST / 4K / 1440p / 1080p / 720p / 480p, or M4A / MP3
- 📱 **Vertical reel previews** — Instagram reels show a proper 9:16 preview card
- 🌗 **Light & dark themes** — follows your OS, one-click toggle, persisted
- 📊 **Live progress** — percent, speed, ETA, a processing phase, and cancel
- 🗂 **Session history** — re-download any capture for 15 minutes, with file sizes
- 🔒 **Self-hosted** — your server, your data; per-IP rate limiting built in

The server is a **single static Go binary** (~6.5 MB, ~12 MB RSS at idle) with
the React UI embedded via `embed.FS` — download one file, run it, done. A
TypeScript/Node implementation of the same API lives in `server/` for reference.

```
self-hosted-video-downloader/
├─ cmd/downcut/          Go entry point (graceful shutdown, embedded UI)
├─ internal/
│  ├─ api/               routes + handlers + thumb proxy (stdlib net/http)
│  ├─ jobs/              job store: goroutine per job, TTL cleanup, cancel
│  ├─ ytdlp/             yt-dlp wrapper: probe, download, cookies, friendly errors
│  └─ ratelimit/         per-IP limiter
├─ web/                  Vite + React UI ("broadcast capture deck") + embed.go
├─ server/               original Node/Hono implementation (same API contract)
└─ Dockerfile            multi-stage: UI build → Go build → ffmpeg+yt-dlp runtime
```

## ⚠️ Self-hosted — read this

This is **self-hosted software**. **You** run the instance and are **solely
responsible** for how it is used. Only download content you own or have the right
to download, and respect each platform's Terms of Service and copyright law. The
software and its authors provide **no warranty and accept no liability**. This is
not an endorsement of downloading copyrighted material.

## Quick start (Go — recommended)

Requires Go 1.25+, Node 20+ (UI build only), plus `yt-dlp` and `ffmpeg` on your
PATH (`brew install yt-dlp ffmpeg` on macOS, `apt install ffmpeg` +
[yt-dlp install](https://github.com/yt-dlp/yt-dlp#installation) on Linux).

```bash
npm install && make build   # builds the UI, embeds it into the Go binary
./downcut                   # serves UI + API on :8787
# open http://localhost:8787
```

The result is one self-contained `downcut` binary — copy it to any machine that
has `yt-dlp` + `ffmpeg` and run it. `make test` / `make lint` for checks.

### Node alternative

The original TypeScript server in `server/` speaks the identical API:

```bash
npm install && npm run build && npm start    # same app on :8787
```

### Development (hot reload)

```bash
npm run dev
# UI:  http://localhost:5174   (Vite, proxies /api → :8787)
# API: http://localhost:8787   (Node server; or run ./downcut instead)
```

## How do I download an Instagram reel?

Paste the reel link (`instagram.com/reel/…`). **Public reels work right away** —
no login needed. Private or age-restricted posts need a logged-in session:

```bash
# 1. Reuse your browser's Instagram session (easiest on your own machine)
YTDLP_COOKIES_BROWSER=chrome ./downcut

# 2. Or export cookies.txt (e.g. "Get cookies.txt LOCALLY" browser extension)
YTDLP_COOKIES=/path/to/cookies.txt ./downcut
```

The same cookies also unlock age-restricted / members-only YouTube videos.
Note: macOS may show a keychain prompt the first time `chrome` cookies are read.

## How do I cut a section of a video?

Paste a link → toggle **✂ Cut a section** → drag the two handles on the
timeline (or type exact times like `1:23:45`) → **Capture Clip**. Only the
selected range is downloaded, with clean keyframes at the cut points.

## Deploy with Docker

The image bundles `yt-dlp` + `ffmpeg`, builds the UI, and runs the server.

```bash
docker build -t downcut .
docker run -p 8787:8787 downcut
```

Deploy to any container host — **Railway**, **Render**, **Fly.io**, or
**Azure Container Apps**. They each take a Dockerfile directly.

### Note on public deployments

Public YouTube downloaders get **IP rate-limited / blocked** by YouTube within
days. To keep one running you typically need to pass cookies or a proxy via
yt-dlp. Keep this instance private (or behind auth) for the smoothest experience.

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8787` | HTTP port |
| `YTDLP_PATH` | `yt-dlp` | path to the yt-dlp binary |
| `RATE_MAX_PER_WINDOW` | `10` | downloads per IP per 5 min |
| `RATE_MAX_CONCURRENT` | `3` | simultaneous downloads per IP |
| `YTDLP_COOKIES` | — | path to a Netscape `cookies.txt` (for Instagram / gated videos) |
| `YTDLP_COOKIES_BROWSER` | — | read cookies from a local browser: `chrome`, `safari`, `firefox`, `edge` |

## API

| Method | Path | Body / Result |
|--------|------|---------------|
| `POST` | `/api/info` | `{url}` → `{title, thumbnail, duration, …}` |
| `POST` | `/api/jobs` | `{url, type, quality, start?, end?}` → `{id, status, …}` (`start`/`end` in seconds cut that section) |
| `GET`  | `/api/jobs/:id` | job status + progress + file size |
| `DELETE` | `/api/jobs/:id` | cancel a running job |
| `GET`  | `/api/jobs/:id/file` | the finished file (attachment) |
| `GET`  | `/api/thumb?u=` | thumbnail proxy (allowlisted CDNs only) |

Files are kept in a temp dir and auto-deleted 15 minutes after completion.

## License

MIT © Sagar
