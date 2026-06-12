import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { download, type DownloadType, type Section } from "./ytdlp.js";

export type JobStatus = "running" | "done" | "error";

export interface Job {
  id: string;
  status: JobStatus;
  percent: number;
  speed: string;
  eta: string;
  fileName?: string;
  filePath?: string;
  sizeBytes?: number;
  error?: string;
  createdAt: number;
  cancelled?: boolean;
  cancelFn?: () => void;
}

// Public view sent to the client (no server paths).
export interface JobView {
  id: string;
  status: JobStatus;
  percent: number;
  speed: string;
  eta: string;
  fileName?: string;
  sizeBytes?: number;
  error?: string;
}

const jobs = new Map<string, Job>();
let counter = 0;

// Files live for 15 min, then get cleaned up.
const TTL_MS = 15 * 60 * 1000;

function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export function view(job: Job): JobView {
  return {
    id: job.id,
    status: job.status,
    percent: Math.round(job.percent),
    speed: job.speed,
    eta: job.eta,
    fileName: job.fileName,
    sizeBytes: job.sizeBytes,
    error: job.error,
  };
}

export function get(id: string): Job | undefined {
  return jobs.get(id);
}

export async function start(
  url: string,
  type: DownloadType,
  quality: string,
  onSettle?: () => void,
  section?: Section,
): Promise<Job> {
  const id = newId();
  const dir = await mkdtemp(join(tmpdir(), "downcut-"));
  const job: Job = {
    id,
    status: "running",
    percent: 0,
    speed: "",
    eta: "",
    createdAt: Date.now(),
  };
  jobs.set(id, job);

  const { promise, cancel } = download(
    url,
    type,
    quality,
    dir,
    (p) => {
      job.percent = p.percent;
      job.speed = p.speed;
      job.eta = p.eta;
    },
    section,
  );
  job.cancelFn = cancel;

  promise
    .then(async (filePath) => {
      job.filePath = filePath;
      job.fileName = basename(filePath);
      job.sizeBytes = await stat(filePath).then((s) => s.size).catch(() => undefined);
      job.percent = 100;
      job.status = "done";
      scheduleCleanup(id, dir);
    })
    .catch((e: Error) => {
      job.status = "error";
      job.error = job.cancelled ? "Cancelled." : e.message;
      void rm(dir, { recursive: true, force: true });
    })
    .finally(() => onSettle?.());

  return job;
}

/** Cancel a running job. Returns false when it isn't running. */
export function cancel(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running" || !job.cancelFn) return false;
  job.cancelled = true;
  job.cancelFn();
  return true;
}

function scheduleCleanup(id: string, dir: string): void {
  setTimeout(() => {
    void rm(dir, { recursive: true, force: true });
    jobs.delete(id);
  }, TTL_MS).unref();
}
