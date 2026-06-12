// Tiny in-memory per-IP limiter. Self-hosted single instance — keeps a runaway
// client (or a shared link) from spawning unlimited downloads. Tune via env.

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.RATE_MAX_PER_WINDOW ?? 10);
const MAX_CONCURRENT = Number(process.env.RATE_MAX_CONCURRENT ?? 3);

const hits = new Map<string, number[]>();
const active = new Map<string, number>();

export function checkRate(ip: string): { ok: boolean; reason?: string } {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    return { ok: false, reason: "Too many downloads. Try again in a few minutes." };
  }
  if ((active.get(ip) ?? 0) >= MAX_CONCURRENT) {
    return { ok: false, reason: "Too many downloads running at once. Wait for them to finish." };
  }
  recent.push(now);
  hits.set(ip, recent);
  return { ok: true };
}

export function markActive(ip: string, delta: number): void {
  active.set(ip, Math.max(0, (active.get(ip) ?? 0) + delta));
}
