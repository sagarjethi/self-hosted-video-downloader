import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelJob,
  fetchInfo,
  fileUrl,
  pollJob,
  startJob,
  type JobView,
  type MediaInfo,
} from "./api";

type Type = "video" | "audio";
type Theme = "dark" | "light";
type SourceTab = "youtube" | "instagram";

const TAB_COPY: Record<SourceTab, { placeholder: string; hint: string }> = {
  youtube: {
    placeholder: "https://youtube.com/watch?v=…",
    hint: "Paste a YouTube video or Shorts link to begin.",
  },
  instagram: {
    placeholder: "https://instagram.com/reel/…",
    hint: "Paste an Instagram reel or post link to begin. Public reels work right away.",
  },
};

function detectTab(u: string): SourceTab | null {
  if (/instagram\.com/i.test(u)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(u)) return "youtube";
  return null;
}

interface HistoryItem {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  sizeBytes?: number;
  at: number;
}

function initialTheme(): Theme {
  const saved = localStorage.getItem("downcut-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

const VIDEO_QUALITIES = [
  { id: "best", label: "BEST" },
  { id: "2160", label: "4K" },
  { id: "1440", label: "1440p" },
  { id: "1080", label: "1080p" },
  { id: "720", label: "720p" },
  { id: "480", label: "480p" },
];
const AUDIO_FORMATS = [
  { id: "m4a", label: "M4A" },
  { id: "mp3", label: "MP3" },
];

function sourceName(extractor: string): string {
  const e = extractor.toLowerCase();
  if (e.includes("youtube")) return "YouTube";
  if (e.includes("instagram")) return "Instagram";
  if (e.includes("tiktok")) return "TikTok";
  return extractor || "Source";
}

function fmtTime(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function fmtBytes(n?: number): string {
  if (!n || !Number.isFinite(n)) return "";
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parse "1:23:45", "12:34" or "90" into seconds. NaN when invalid. */
function parseTime(v: string): number {
  const parts = v.trim().split(":").map((p) => p.trim());
  if (!parts.length || parts.some((p) => p === "" || !/^\d+$/.test(p))) return NaN;
  if (parts.length > 3) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Editable time field that commits on blur / Enter. */
function TimeField({
  value,
  max,
  onCommit,
}: {
  value: number;
  max: number;
  onCommit: (secs: number) => void;
}) {
  const [text, setText] = useState(fmtTime(value));
  useEffect(() => setText(fmtTime(value)), [value]);
  const commit = () => {
    const secs = parseTime(text);
    if (Number.isFinite(secs)) onCommit(Math.min(Math.max(0, secs), max));
    else setText(fmtTime(value));
  };
  return (
    <input
      className="time-field"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      spellCheck={false}
      inputMode="numeric"
    />
  );
}

export function App() {
  const [url, setUrl] = useState("");
  const [tab, setTab] = useState<SourceTab>("youtube");
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [type, setType] = useState<Type>("video");
  const [videoQuality, setVideoQuality] = useState("best");
  const [audioFormat, setAudioFormat] = useState("m4a");

  const [cutOn, setCutOn] = useState(false);
  const [cutStart, setCutStart] = useState(0);
  const [cutEnd, setCutEnd] = useState(0);

  const [job, setJob] = useState<JobView | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const lastProbed = useRef<string>("");

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const jobTitle = useRef<string>("");

  // Apply + persist the theme.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("downcut-theme", theme);
  }, [theme]);

  // Paste anywhere on the page to fill the link box.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const text = e.clipboardData?.getData("text")?.trim() ?? "";
      if (/^https?:\/\/\S+\.\S+/.test(text)) setUrl(text);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const probe = useCallback(async (value: string) => {
    const v = value.trim();
    if (!v || v === lastProbed.current) return;
    lastProbed.current = v;
    setProbing(true);
    setProbeError(null);
    setInfo(null);
    setCutOn(false);
    try {
      const i = await fetchInfo(v);
      setInfo(i);
      setCutStart(0);
      setCutEnd(i.duration || 0);
    } catch (e) {
      setProbeError((e as Error).message);
    } finally {
      setProbing(false);
    }
  }, []);

  // Auto-probe shortly after a plausible URL is pasted/typed,
  // and flip the source tab to match the link.
  useEffect(() => {
    const v = url.trim();
    if (!/^https?:\/\/\S+\.\S+/.test(v)) return;
    const detected = detectTab(v);
    if (detected) setTab(detected);
    const t = setTimeout(() => probe(v), 600);
    return () => clearTimeout(t);
  }, [url, probe]);

  // Poll an active job until it settles.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    let alive = true;
    const tick = async () => {
      try {
        const next = await pollJob(job.id);
        if (!alive) return;
        setJob(next);
        if (next.status === "done") {
          triggerSave(next.id);
          recordHistory(next, true);
        }
        if (next.status === "error") {
          setJobError(next.error ?? "Download failed.");
          recordHistory(next, false);
        }
      } catch (e) {
        if (alive) setJobError((e as Error).message);
      }
    };
    const iv = setInterval(tick, 650);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [job]);

  const quality = type === "video" ? videoQuality : audioFormat;
  const busy = job?.status === "running";
  const isReel = Boolean(info?.extractor.includes("instagram"));
  // Reels top out at 1080p — hide qualities that can't apply.
  const qualities = isReel
    ? VIDEO_QUALITIES.filter((q) => !["2160", "1440"].includes(q.id))
    : VIDEO_QUALITIES;

  // If a hidden quality was selected before switching to a reel, fall back.
  useEffect(() => {
    if (isReel && ["2160", "1440"].includes(videoQuality)) setVideoQuality("best");
  }, [isReel, videoQuality]);

  const duration = info?.duration ?? 0;
  const cutActive =
    cutOn && duration > 0 && cutEnd > cutStart && (cutStart > 0 || cutEnd < duration);

  async function onCapture() {
    if (!url.trim() || busy) return;
    setJobError(null);
    setJob(null);
    jobTitle.current = info?.title ?? url.trim();
    try {
      const started = await startJob(
        url.trim(),
        type,
        quality,
        cutActive ? { start: cutStart, end: cutEnd } : undefined,
      );
      setJob(started);
    } catch (e) {
      setJobError((e as Error).message);
    }
  }

  function recordHistory(j: JobView, ok: boolean) {
    setHistory((prev) =>
      prev.some((h) => h.id === j.id)
        ? prev
        : [
            {
              id: j.id,
              name: j.fileName ?? jobTitle.current,
              ok,
              error: j.error,
              sizeBytes: j.sizeBytes,
              at: Date.now(),
            },
            ...prev,
          ].slice(0, 12),
    );
  }

  /** Manual tab click — start fresh so the platforms feel like separate decks. */
  function switchTab(next: SourceTab) {
    if (next === tab) return;
    setTab(next);
    setUrl("");
    setInfo(null);
    setProbeError(null);
    setCutOn(false);
    lastProbed.current = "";
    reset();
  }

  function clearInput() {
    setUrl("");
    setInfo(null);
    setProbeError(null);
    lastProbed.current = "";
  }

  async function onCancel() {
    if (!job || job.status !== "running") return;
    await cancelJob(job.id).catch(() => {});
    reset();
  }

  function triggerSave(id: string) {
    const a = document.createElement("a");
    a.href = fileUrl(id);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function reset() {
    setJob(null);
    setJobError(null);
  }

  return (
    <div className="stage">
      <div className="shell">
        <header className="masthead">
          <div className="brand">
            <div className="reel" aria-hidden />
            <div>
              <div className="wordmark">
                DOWN<b>CUT</b>
              </div>
              <div className="tagline">Media Capture Deck</div>
            </div>
          </div>
          <div className="head-actions">
            <button
              className="theme-btn"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <span className="badge">
              <span className="led" /> Self-Hosted
            </span>
          </div>
        </header>

        <section className="deck">
          <div className="src-tabs" role="tablist" aria-label="Source platform">
            <button
              role="tab"
              aria-selected={tab === "youtube"}
              onClick={() => switchTab("youtube")}
            >
              ▶ YouTube
            </button>
            <button
              role="tab"
              aria-selected={tab === "instagram"}
              onClick={() => switchTab("instagram")}
            >
              ◎ Instagram
            </button>
          </div>
          <div className="field-label">Source Link</div>
          <form
            className="intake"
            onSubmit={(e) => {
              e.preventDefault();
              probe(url);
            }}
          >
            <div className="input-wrap">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && clearInput()}
                placeholder={TAB_COPY[tab].placeholder}
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
              <button
                type="button"
                className="paste-btn"
                title="Paste from clipboard"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    if (text.trim()) {
                      setUrl(text.trim());
                      probe(text);
                    }
                  } catch {
                    /* clipboard permission denied — user can paste manually */
                  }
                }}
              >
                ⎘ Paste
              </button>
            </div>
            <button
              type="submit"
              className="scan-btn"
              disabled={probing || !url.trim()}
            >
              {probing ? "Scanning…" : "Scan"}
            </button>
          </form>

          {probeError && <div className="note err">⚠ {probeError}</div>}
          {!probeError && !info && !probing && (
            <>
              <div className="steps" aria-hidden>
                <span className="step">
                  <b>1</b> Paste link
                </span>
                <span className="step-arrow">→</span>
                <span className="step">
                  <b>2</b> Preview
                </span>
                <span className="step-arrow">→</span>
                <span className="step">
                  <b>3</b> Capture
                </span>
              </div>
              <div className="note">{TAB_COPY[tab].hint}</div>
            </>
          )}

          {probing && (
            <div className="card skeleton" aria-hidden>
              <div className={`thumb ${tab === "instagram" ? "thumb-tall" : ""} sk-block`} />
              <div className="card-meta">
                <div className="sk-line sk-block" />
                <div className="sk-line sk-block short" />
              </div>
            </div>
          )}

          {info && (
            <>
              <div className={`card ${isReel ? "card-reel" : ""}`}>
                {info.thumbnail ? (
                  <img
                    className={`thumb ${isReel ? "thumb-tall" : ""}`}
                    src={
                      isReel
                        ? `/api/thumb?u=${encodeURIComponent(info.thumbnail)}`
                        : info.thumbnail
                    }
                    referrerPolicy="no-referrer"
                    alt=""
                  />
                ) : (
                  <div className={`thumb ${isReel ? "thumb-tall" : ""}`} />
                )}
                <div className="card-meta">
                  <div className="card-title">{info.title}</div>
                  <div className="card-sub">
                    <span className="chip-source">{sourceName(info.extractor)}</span>
                    {info.uploader && <span>{info.uploader}</span>}
                    {info.durationText && <span>· {info.durationText}</span>}
                    {info.isLive && <span>· LIVE</span>}
                  </div>
                </div>
              </div>

              <div className="options">
                <div>
                  <div className="field-label">Format</div>
                  <div className="seg">
                    <button
                      aria-pressed={type === "video"}
                      onClick={() => setType("video")}
                    >
                      <span className="ico">▶</span> Video
                    </button>
                    <button
                      aria-pressed={type === "audio"}
                      onClick={() => setType("audio")}
                    >
                      <span className="ico">♫</span> Audio
                    </button>
                  </div>
                </div>

                <div>
                  <div className="field-label">
                    {type === "video" ? "Quality" : "Audio Codec"}
                  </div>
                  <div className="chips">
                    {(type === "video" ? qualities : AUDIO_FORMATS).map((o) => {
                      const active =
                        type === "video"
                          ? videoQuality === o.id
                          : audioFormat === o.id;
                      return (
                        <button
                          key={o.id}
                          className="chip"
                          aria-pressed={active}
                          onClick={() =>
                            type === "video"
                              ? setVideoQuality(o.id)
                              : setAudioFormat(o.id)
                          }
                        >
                          {o.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {duration > 0 && !info.isLive && (
                <div className="cut-block">
                  <button
                    className="cut-toggle"
                    aria-pressed={cutOn}
                    onClick={() => setCutOn(!cutOn)}
                  >
                    <span className="cut-ico">✂</span> Cut a section
                    <span className="cut-state">{cutOn ? "ON" : "OFF"}</span>
                  </button>

                  {cutOn && (
                    <div className="cut-panel">
                      <div className="cut-rail">
                        <div
                          className="cut-fill"
                          style={{
                            left: `${(cutStart / duration) * 100}%`,
                            width: `${((cutEnd - cutStart) / duration) * 100}%`,
                          }}
                        />
                        <input
                          type="range"
                          min={0}
                          max={duration}
                          step={1}
                          value={cutStart}
                          onChange={(e) =>
                            setCutStart(Math.min(Number(e.target.value), cutEnd - 1))
                          }
                          aria-label="Cut start"
                        />
                        <input
                          type="range"
                          min={0}
                          max={duration}
                          step={1}
                          value={cutEnd}
                          onChange={(e) =>
                            setCutEnd(Math.max(Number(e.target.value), cutStart + 1))
                          }
                          aria-label="Cut end"
                        />
                      </div>
                      <div className="cut-times">
                        <TimeField
                          value={cutStart}
                          max={Math.max(0, cutEnd - 1)}
                          onCommit={(s) => setCutStart(Math.min(s, cutEnd - 1))}
                        />
                        <span className="cut-len">
                          ✂ {fmtTime(cutEnd - cutStart)}
                          <i> / {fmtTime(duration)}</i>
                        </span>
                        <TimeField
                          value={cutEnd}
                          max={duration}
                          onCommit={(s) => setCutEnd(Math.max(s, cutStart + 1))}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!job && (
                <button className="capture" onClick={onCapture} disabled={busy}>
                  <span>⤓</span>
                  {cutActive
                    ? `Capture Clip · ${fmtTime(cutEnd - cutStart)}`
                    : type === "video"
                      ? "Capture Video"
                      : "Capture Audio"}
                </button>
              )}

              {busy && (
                <div className="meter-wrap" role="status" aria-live="polite">
                  <div className="meter-head">
                    <span>{job.percent >= 100 ? "Processing…" : "Capturing…"}</span>
                    <span className="meter-pct">
                      <b>{job.percent}</b>%
                    </span>
                  </div>
                  <div className={`meter ${job.percent >= 100 ? "meter-indet" : ""}`}>
                    <div className="meter-fill" style={{ width: `${job.percent}%` }} />
                  </div>
                  <div className="meter-sub">
                    {job.speed && <span>↓ {job.speed}</span>}
                    {job.eta && <span>ETA {job.eta}</span>}
                    <button className="cancel-btn" onClick={onCancel}>
                      ✕ Cancel
                    </button>
                  </div>
                </div>
              )}

              {job?.status === "done" && (
                <div className="save-stack">
                  <div className="save-row">
                    <a className="save-btn" href={fileUrl(job.id)} download>
                      ⤓ Save File
                    </a>
                    <button className="reset-btn" onClick={reset}>
                      New
                    </button>
                  </div>
                  {job.fileName && (
                    <div className="done-file">
                      ✓ {job.fileName}
                      {job.sizeBytes ? ` · ${fmtBytes(job.sizeBytes)}` : ""}
                    </div>
                  )}
                </div>
              )}

              {jobError && (
                <div className="err-row">
                  <div className="note err">⚠ {jobError}</div>
                  <button
                    className="retry-btn"
                    onClick={() => {
                      reset();
                      onCapture();
                    }}
                  >
                    ↻ Retry
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {history.length > 0 && (
          <section className="history">
            <div className="history-head">
              <span className="field-label" style={{ marginBottom: 0 }}>
                Session Captures
              </span>
              <button className="history-clear" onClick={() => setHistory([])}>
                Clear
              </button>
            </div>
            {history.map((h) => (
              <div key={h.id} className="history-row">
                <span className={`history-dot ${h.ok ? "ok" : "bad"}`} />
                <span className="history-name" title={h.name}>
                  {h.name}
                </span>
                <span className="history-meta">
                  {h.ok && h.sizeBytes ? `${fmtBytes(h.sizeBytes)} · ` : ""}
                  {fmtClock(h.at)}
                </span>
                {h.ok ? (
                  <a className="history-link" href={fileUrl(h.id)} download>
                    ⤓ Save
                  </a>
                ) : (
                  <span className="history-err">{h.error ?? "failed"}</span>
                )}
              </div>
            ))}
            <div className="history-note">
              Files stay available for 15 minutes after capture.
            </div>
          </section>
        )}

        <footer className="fineprint">
          <b>Self-hosted software.</b> You operate this instance and are solely
          responsible for how it is used. Only download content you own or have the
          right to download. The software and its authors accept no liability and
          provide no warranty. Respect each platform's Terms of Service and copyright law.
        </footer>
      </div>
    </div>
  );
}
