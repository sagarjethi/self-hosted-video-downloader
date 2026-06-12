# Downcut — Go server + embedded React UI + yt-dlp + ffmpeg, one image.

# Stage 1: build the React UI
FROM node:20-slim AS ui
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY vite.config.ts ./
COPY web ./web
RUN npm run build

# Stage 2: build the Go binary with the UI embedded
FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go ./web/embed.go
COPY --from=ui /app/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /downcut ./cmd/downcut

# Stage 3: runtime — ffmpeg for muxing, yt-dlp standalone binary
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
       -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && apt-get purge -y curl

COPY --from=build /downcut /usr/local/bin/downcut

ENV PORT=8787
EXPOSE 8787
CMD ["downcut"]
