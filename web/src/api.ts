export interface MediaInfo {
  title: string;
  thumbnail: string | null;
  duration: number;
  durationText: string;
  uploader: string | null;
  extractor: string;
  webpageUrl: string;
  isLive: boolean;
}

export interface JobView {
  id: string;
  status: "running" | "done" | "error";
  percent: number;
  speed: string;
  eta: string;
  fileName?: string;
  sizeBytes?: number;
  error?: string;
}

async function jsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export async function fetchInfo(url: string): Promise<MediaInfo> {
  return jsonOrThrow(
    await fetch("/api/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  );
}

export async function startJob(
  url: string,
  type: "video" | "audio",
  quality: string,
  cut?: { start: number; end: number },
): Promise<JobView> {
  return jsonOrThrow(
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, type, quality, ...cut }),
    }),
  );
}

export async function pollJob(id: string): Promise<JobView> {
  return jsonOrThrow(await fetch(`/api/jobs/${id}`));
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}`, { method: "DELETE" });
}

export function fileUrl(id: string): string {
  return `/api/jobs/${id}/file`;
}
