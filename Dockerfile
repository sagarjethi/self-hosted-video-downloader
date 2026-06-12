# Self-hosted Downcut downloader — UI + API + yt-dlp + ffmpeg in one image.
FROM node:20-slim

# System deps: ffmpeg for muxing, ca-certs/curl to fetch the yt-dlp binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone linux binary (self-contained, no python needed).
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN npm install

# Build the UI, then drop dev deps that aren't needed at runtime (vite stays
# out; tsx + hono are required to run the server).
COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# tsx runs the TypeScript server directly; web/dist is served statically.
CMD ["npm", "start"]
