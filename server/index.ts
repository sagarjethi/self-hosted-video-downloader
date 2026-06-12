import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { probe, type DownloadType, type Section } from "./ytdlp.js";
import * as jobsStore from "./jobs.js";
import { checkRate, markActive } from "./ratelimit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web", "dist");
const PORT = Number(process.env.PORT ?? 8787);

const app = new Hono();

function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    headers.get("x-real-ip") ||
    "local"
  );
}

function isValidUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2048) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

app.get("/api/health", (c) => c.json({ ok: true }));

// Proxy media thumbnails that block cross-origin browser loads (Instagram CDN).
// Host-allowlisted to prevent SSRF.
const THUMB_HOSTS = [".cdninstagram.com", ".fbcdn.net", ".ytimg.com", ".googleusercontent.com"];
app.get("/api/thumb", async (c) => {
  const raw = c.req.query("u") ?? "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return c.json({ error: "Bad URL." }, 400);
  }
  const allowed =
    target.protocol === "https:" &&
    THUMB_HOSTS.some((h) => target.hostname.endsWith(h));
  if (!allowed) return c.json({ error: "Host not allowed." }, 403);

  try {
    const res = await fetch(target, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    });
    if (!res.ok || !res.body) return c.json({ error: "Upstream failed." }, 502);
    c.header("Content-Type", res.headers.get("content-type") ?? "image/jpeg");
    c.header("Cache-Control", "public, max-age=600");
    return c.body(res.body);
  } catch {
    return c.json({ error: "Fetch failed." }, 502);
  }
});

app.post("/api/info", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isValidUrl(body.url)) return c.json({ error: "Enter a valid http(s) link." }, 400);
  try {
    const info = await probe(body.url);
    return c.json(info);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

app.post("/api/jobs", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!isValidUrl(body.url)) return c.json({ error: "Enter a valid http(s) link." }, 400);

  const type: DownloadType = body.type === "audio" ? "audio" : "video";
  const quality = String(body.quality ?? (type === "audio" ? "m4a" : "best"));

  // Optional cut range (seconds). Max 4h, end must be after start.
  let section: Section | undefined;
  if (body.start != null || body.end != null) {
    const start = Number(body.start ?? 0);
    const end = Number(body.end);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end - start > 4 * 3600
    ) {
      return c.json({ error: "Invalid cut range." }, 400);
    }
    section = { start: Math.floor(start), end: Math.ceil(end) };
  }

  const ip = clientIp(c.req.raw.headers);
  const rate = checkRate(ip);
  if (!rate.ok) return c.json({ error: rate.reason }, 429);

  markActive(ip, 1);
  try {
    const job = await jobsStore.start(
      body.url,
      type,
      quality,
      () => markActive(ip, -1),
      section,
    );
    return c.json(jobsStore.view(job), 202);
  } catch (e) {
    markActive(ip, -1);
    return c.json({ error: (e as Error).message }, 500);
  }
});

app.get("/api/jobs/:id", (c) => {
  const job = jobsStore.get(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found or expired." }, 404);
  return c.json(jobsStore.view(job));
});

app.delete("/api/jobs/:id", (c) => {
  const ok = jobsStore.cancel(c.req.param("id"));
  if (!ok) return c.json({ error: "Job is not running." }, 409);
  return c.json({ ok: true });
});

app.get("/api/jobs/:id/file", async (c) => {
  const job = jobsStore.get(c.req.param("id"));
  if (!job || job.status !== "done" || !job.filePath) {
    return c.json({ error: "File not ready." }, 404);
  }
  let size: number;
  try {
    size = (await stat(job.filePath)).size;
  } catch {
    return c.json({ error: "File expired. Please download again." }, 410);
  }
  const name = job.fileName ?? "download";
  const ext = name.split(".").pop()?.toLowerCase();
  const ctype =
    ext === "mp4" ? "video/mp4" :
    ext === "mp3" ? "audio/mpeg" :
    ext === "m4a" ? "audio/mp4" :
    ext === "webm" ? "video/webm" : "application/octet-stream";

  c.header("Content-Type", ctype);
  c.header("Content-Length", String(size));
  c.header(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  return c.body(Readable.toWeb(createReadStream(job.filePath)) as ReadableStream);
});

// Serve the built SPA (production). In dev, Vite serves the UI and proxies /api.
app.use("/*", serveStatic({ root: WEB_DIR }));
app.get("/*", serveStatic({ path: "index.html", root: WEB_DIR }));

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[downloader] listening on http://localhost:${info.port}`);
});
