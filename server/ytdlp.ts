import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type DownloadType = "video" | "audio";
export type VideoQuality = "best" | "1080" | "720" | "480";
export type AudioFormat = "mp3" | "m4a";

/** Optional cut range in seconds (start inclusive, end exclusive). */
export interface Section {
  start: number;
  end: number;
}

export interface MediaInfo {
  title: string;
  thumbnail: string | null;
  duration: number; // seconds, 0 if unknown/live
  durationText: string;
  uploader: string | null;
  extractor: string; // e.g. "youtube", "instagram"
  webpageUrl: string;
  isLive: boolean;
}

const YTDLP = process.env.YTDLP_PATH ?? "yt-dlp";

/**
 * Optional authentication for gated content (Instagram reels, age-restricted
 * or member-only videos). Set ONE of:
 *   YTDLP_COOKIES         — path to a Netscape cookies.txt export
 *   YTDLP_COOKIES_BROWSER — browser to read cookies from (chrome|safari|firefox|edge)
 */
function cookieArgs(): string[] {
  if (process.env.YTDLP_COOKIES) return ["--cookies", process.env.YTDLP_COOKIES];
  if (process.env.YTDLP_COOKIES_BROWSER)
    return ["--cookies-from-browser", process.env.YTDLP_COOKIES_BROWSER];
  return [];
}

const hasAuth = () =>
  Boolean(process.env.YTDLP_COOKIES || process.env.YTDLP_COOKIES_BROWSER);

function fmtDuration(secs: number): string {
  if (!secs || !Number.isFinite(secs)) return "";
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** Run yt-dlp and resolve with parsed JSON, or reject with a clean message. */
function run(args: string[], opts: { capture?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("yt-dlp is not installed on the server."));
      } else reject(e);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`));
    });
  });
}

function cleanError(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reverse()
    .find((l) => l.startsWith("ERROR:"));
  if (!line) return "";
  const raw = line.replace(/^ERROR:\s*/, "").replace(/\s*\[.*?\]\s*/g, " ").trim();
  return friendlyError(raw);
}

/** Map yt-dlp's wall-of-text errors to short, actionable messages. */
function friendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  const authHint = hasAuth()
    ? "The configured cookies may be expired — refresh them and restart."
    : "This server has no login cookies configured. Set YTDLP_COOKIES_BROWSER=chrome (or YTDLP_COOKIES=/path/to/cookies.txt) and restart.";

  if (
    lower.includes("empty media response") ||
    lower.includes("login required") ||
    lower.includes("requested content is not available") ||
    lower.includes("rate-limit reached")
  ) {
    return `This post needs a logged-in session (common for Instagram). ${authHint}`;
  }
  if (lower.includes("sign in to confirm your age") || lower.includes("age-restricted")) {
    return `This video is age-restricted. ${authHint}`;
  }
  if (lower.includes("private video") || lower.includes("this video is private")) {
    return "This video is private — it can only be downloaded by an account that has access.";
  }
  if (lower.includes("video unavailable") || lower.includes("404")) {
    return "Video unavailable — it may have been removed or the link is wrong.";
  }
  if (lower.includes("unsupported url")) {
    return "This link type isn't supported.";
  }
  // Keep unknown errors but trim the boilerplate yt-dlp appends.
  return raw.split(". See ")[0].split(" Otherwise,")[0].trim();
}

/** Probe a URL for title/thumbnail/duration without downloading. */
export async function probe(url: string): Promise<MediaInfo> {
  const out = await run([
    "-J",
    "--no-playlist",
    "--no-warnings",
    "--playlist-items",
    "1",
    ...cookieArgs(),
    url,
  ]);
  const j = JSON.parse(out);
  const meta = Array.isArray(j.entries) && j.entries.length ? j.entries[0] : j;
  const duration = Number(meta.duration) || 0;
  return {
    title: meta.title ?? meta.id ?? "Untitled",
    thumbnail: meta.thumbnail ?? null,
    duration,
    durationText: fmtDuration(duration),
    uploader: meta.uploader ?? meta.channel ?? meta.uploader_id ?? null,
    extractor: (meta.extractor_key ?? meta.extractor ?? "").toLowerCase(),
    webpageUrl: meta.webpage_url ?? url,
    isLive: Boolean(meta.is_live),
  };
}

/** Build the yt-dlp argument list for a download into `dir`. */
export function buildDownloadArgs(
  url: string,
  type: DownloadType,
  quality: string,
  dir: string,
  section?: Section,
): string[] {
  const outTemplate = join(dir, "%(title).80B [%(id)s].%(ext)s");
  const base = [
    "--no-playlist",
    "--no-warnings",
    "--restrict-filenames",
    "--no-part",
    "-o",
    outTemplate,
    "--newline",
    "--progress-template",
    "DLP|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    ...cookieArgs(),
  ];

  // Cut: fetch only the selected range and re-keyframe at the cut points so
  // the clip starts cleanly instead of freezing until the next keyframe.
  if (section) {
    base.push(
      "--download-sections",
      `*${section.start}-${section.end}`,
      "--force-keyframes-at-cuts",
    );
  }

  if (type === "audio") {
    const fmt: AudioFormat = quality === "mp3" ? "mp3" : "m4a";
    return [...base, "-f", "ba/b", "-x", "--audio-format", fmt, url];
  }

  // video
  let format = "bv*+ba/b";
  if (quality !== "best") {
    const h = parseInt(quality, 10);
    if (Number.isFinite(h)) format = `bv*[height<=${h}]+ba/b[height<=${h}]/b`;
  }
  return [...base, "-f", format, "--merge-output-format", "mp4", url];
}

export interface ProgressUpdate {
  percent: number;
  speed: string;
  eta: string;
}

/**
 * Spawn a download. Calls onProgress as yt-dlp reports, resolves with the
 * final file path on success.
 */
export function download(
  url: string,
  type: DownloadType,
  quality: string,
  dir: string,
  onProgress: (p: ProgressUpdate) => void,
  section?: Section,
): { promise: Promise<string>; cancel: () => void } {
  const args = buildDownloadArgs(url, type, quality, dir, section);
  const child = spawn(YTDLP, args, { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  let buf = "";

  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("DLP|")) continue;
      const [, pctRaw, speed, eta] = line.split("|");
      const percent = parseFloat((pctRaw ?? "").replace("%", "").trim());
      onProgress({
        percent: Number.isFinite(percent) ? percent : 0,
        speed: (speed ?? "").trim(),
        eta: (eta ?? "").trim(),
      });
    }
  });
  child.stderr.on("data", (d) => (err += d.toString()));

  const promise = new Promise<string>((resolve, reject) => {
    child.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("yt-dlp is not installed on the server."));
      } else reject(e);
    });
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(cleanError(err) || `Download failed (code ${code})`));
        return;
      }
      try {
        resolve(await newestFile(dir));
      } catch (e) {
        reject(e as Error);
      }
    });
  });

  return { promise, cancel: () => child.kill("SIGKILL") };
}

/** Pick the largest finished file in a directory (skips temp fragments). */
async function newestFile(dir: string): Promise<string> {
  const names = await readdir(dir);
  const candidates = names.filter(
    (n) => !n.endsWith(".part") && !n.endsWith(".ytdl") && !/\.f\d+\./.test(n),
  );
  if (!candidates.length) throw new Error("No output file was produced.");
  let best = "";
  let bestSize = -1;
  for (const n of candidates) {
    const p = join(dir, n);
    const s = await stat(p);
    if (s.isFile() && s.size > bestSize) {
      bestSize = s.size;
      best = p;
    }
  }
  if (!best) throw new Error("No output file was produced.");
  return best;
}
