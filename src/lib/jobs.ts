import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config';
import { UserError, toUserMessage } from './errors';
import { buildPlan, describeFfmpegFailure, probeMedia, runFfmpeg, type ConvertPlan } from './ffmpeg';
import { cleanTitle, safeFileBase, stripExtension } from './filename';
import { isActiveStatus, type JobStatus, type JobView, type OutputFormat } from './types';
import { downloadFromUrl } from './ytdlp';

export type JobSource =
  | { type: 'url'; url: string }
  | { type: 'upload'; path: string; originalName: string };

export interface JobInput {
  id: string;
  format: OutputFormat;
  source: JobSource;
  startSec: number | null;
  endSec: number | null;
  title: string | null;
}

interface JobRecord {
  input: JobInput;
  dir: string;
  status: JobStatus;
  progress: number | null;
  fastPath: boolean;
  title: string | null;
  outputPath: string | null;
  outputName: string | null;
  outputSize: number | null;
  mediaDurationSec: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  expiresAt: number | null;
  error: string | null;
  controller: AbortController;
  timedOut: boolean;
}

const JOB_DIR_PATTERN = /^j[a-f0-9]{24}$/;
/** How long finished/expired job records stay visible in history after their files are gone. */
const RECORD_RETENTION_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private readonly reserved = new Map<string, number>();
  private running = 0;
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init();
    const timer = setInterval(() => {
      this.sweep().catch((e) => console.error('[jobs] sweep failed', e));
    }, SWEEP_INTERVAL_MS);
    timer.unref();
  }

  private get cfg() {
    return getConfig();
  }

  /** Creates the storage dir and removes leftovers from a previous run (job records are in-memory). */
  private async init(): Promise<void> {
    const root = this.cfg.storageDir;
    await fsp.mkdir(root, { recursive: true });
    const entries = await fsp.readdir(root).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((e) => JOB_DIR_PATTERN.test(e))
        .map((e) => fsp.rm(path.join(/*turbopackIgnore: true*/ root, e), { recursive: true, force: true }).catch(() => undefined)),
    );
    console.log(
      `[jobs] storage=${root} ttl=${this.cfg.fileTtlMinutes}m concurrency=${this.cfg.maxConcurrentJobs} threads=${this.cfg.ffmpegThreads}`,
    );
  }

  stats() {
    return { running: this.running, queued: this.queue.length, total: this.jobs.size };
  }

  /** Reserves a job id + working directory (used before streaming an upload to disk). */
  async reserve(): Promise<{ id: string; dir: string }> {
    await this.ready;
    const pending = this.queue.length + this.running + this.reserved.size;
    if (pending >= this.cfg.maxQueuedJobs) {
      throw new UserError(`Antrean penuh (${this.cfg.maxQueuedJobs} job). Tunggu beberapa saat lalu coba lagi.`, 429);
    }
    const id = `j${crypto.randomBytes(12).toString('hex')}`;
    const dir = path.join(/*turbopackIgnore: true*/ this.cfg.storageDir, id);
    await fsp.mkdir(dir, { recursive: true });
    this.reserved.set(id, Date.now());
    return { id, dir };
  }

  async release(id: string): Promise<void> {
    this.reserved.delete(id);
    await fsp.rm(path.join(/*turbopackIgnore: true*/ this.cfg.storageDir, id), { recursive: true, force: true }).catch(() => undefined);
  }

  submit(input: JobInput): JobView {
    if (!this.reserved.has(input.id)) throw new UserError('Reservasi job tidak valid.', 500);
    this.reserved.delete(input.id);
    const rec: JobRecord = {
      input,
      dir: path.join(/*turbopackIgnore: true*/ this.cfg.storageDir, input.id),
      status: 'queued',
      progress: null,
      fastPath: false,
      title: input.title,
      outputPath: null,
      outputName: null,
      outputSize: null,
      mediaDurationSec: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      expiresAt: null,
      error: null,
      controller: new AbortController(),
      timedOut: false,
    };
    this.jobs.set(input.id, rec);
    this.queue.push(input.id);
    this.pump();
    return this.view(rec);
  }

  get(id: string): JobView | null {
    const rec = this.jobs.get(id);
    return rec ? this.view(rec) : null;
  }

  /** Returns the on-disk output for a ready job. */
  getDownload(id: string): { path: string; name: string; size: number } | null {
    const rec = this.jobs.get(id);
    if (!rec || rec.status !== 'ready' || !rec.outputPath || !rec.outputName) return null;
    if (rec.expiresAt !== null && rec.expiresAt <= Date.now()) return null;
    return { path: rec.outputPath, name: rec.outputName, size: rec.outputSize ?? 0 };
  }

  list(ids: string[]): { jobs: JobView[]; missing: string[] } {
    const jobs: JobView[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const rec = this.jobs.get(id);
      if (rec) jobs.push(this.view(rec));
      else missing.push(id);
    }
    return { jobs, missing };
  }

  /** Cancels (if active) and deletes a job and its files. */
  async remove(id: string): Promise<boolean> {
    const rec = this.jobs.get(id);
    if (!rec) return false;
    this.abort(rec);
    this.jobs.delete(id);
    await fsp.rm(rec.dir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  /** Cancels an active job but keeps the record (status "cancelled"). */
  async cancel(id: string): Promise<JobView | null> {
    const rec = this.jobs.get(id);
    if (!rec) return null;
    if (isActiveStatus(rec.status)) {
      this.abort(rec);
      await fsp.rm(rec.dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return this.view(rec);
  }

  private abort(rec: JobRecord) {
    if (!isActiveStatus(rec.status)) return;
    const qi = this.queue.indexOf(rec.input.id);
    if (qi >= 0) this.queue.splice(qi, 1);
    rec.status = 'cancelled';
    rec.progress = null;
    rec.finishedAt = Date.now();
    rec.controller.abort();
  }

  private view(rec: JobRecord): JobView {
    const { input } = rec;
    let sourceLabel: string;
    if (input.source.type === 'url') {
      try {
        sourceLabel = new URL(input.source.url).hostname.replace(/^www\./, '');
      } catch {
        sourceLabel = 'URL';
      }
    } else {
      sourceLabel = input.source.originalName;
    }
    const qi = this.queue.indexOf(input.id);
    return {
      id: input.id,
      status: rec.status,
      format: input.format,
      sourceType: input.source.type,
      sourceLabel,
      title: rec.title,
      progress: rec.progress,
      queuePosition: qi >= 0 ? qi + 1 : null,
      fastPath: rec.fastPath,
      outputName: rec.outputName,
      outputSize: rec.outputSize,
      mediaDurationSec: rec.mediaDurationSec,
      trim: { startSec: input.startSec, endSec: input.endSec },
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      expiresAt: rec.expiresAt,
      error: rec.error,
    };
  }

  private pump() {
    while (this.running < this.cfg.maxConcurrentJobs && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const rec = this.jobs.get(id);
      if (!rec || rec.status !== 'queued') continue;
      this.running++;
      this.execute(rec)
        .catch((e) => console.error('[jobs] unexpected execute failure', e))
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private async execute(rec: JobRecord): Promise<void> {
    const cfg = this.cfg;
    const { input } = rec;
    const signal = rec.controller.signal;
    rec.startedAt = Date.now();
    const timeout = setTimeout(() => {
      rec.timedOut = true;
      rec.controller.abort();
    }, cfg.jobTimeoutMinutes * 60 * 1000);
    timeout.unref();

    let sourcePath: string | null = null;
    try {
      // 1) Obtain source file.
      let fetchedTitle: string | null = null;
      if (input.source.type === 'url') {
        rec.status = 'fetching';
        rec.progress = 0;
        const dl = await downloadFromUrl(cfg, input.source.url, input.format, rec.dir, signal, (p) => {
          if (rec.status === 'fetching') rec.progress = p;
        });
        sourcePath = dl.filePath;
        fetchedTitle = dl.title;
      } else {
        sourcePath = input.source.path;
        fetchedTitle = stripExtension(input.source.originalName);
      }
      this.throwIfAborted(rec);

      // 2) Probe and validate.
      rec.status = 'converting';
      rec.progress = null;
      const probe = await probeMedia(cfg, sourcePath, signal);
      this.throwIfAborted(rec);
      const maxSec = cfg.maxDurationMinutes * 60;
      if (probe.durationSec !== null && probe.durationSec > maxSec + 1) {
        throw new UserError(`Durasi media melebihi batas ${cfg.maxDurationMinutes} menit.`);
      }
      if (input.startSec !== null && probe.durationSec !== null && input.startSec >= probe.durationSec) {
        throw new UserError('Waktu mulai melebihi durasi media.');
      }
      const endSec =
        input.endSec !== null && probe.durationSec !== null && input.endSec >= probe.durationSec ? null : input.endSec;
      const outDuration = (endSec ?? probe.durationSec ?? 0) - (input.startSec ?? 0);
      rec.mediaDurationSec = outDuration > 0 ? outDuration : probe.durationSec;

      const title = input.title || cleanTitle(fetchedTitle) || 'media';
      rec.title = title;

      // 3) Convert: fast path (stream copy) first, full transcode as fallback.
      const planFor = (forceTranscode: boolean): ConvertPlan =>
        buildPlan(cfg, {
          format: input.format,
          probe,
          input: sourcePath!,
          outDir: rec.dir,
          title,
          startSec: input.startSec,
          endSec,
          forceTranscode,
        });

      let plan = planFor(false);
      let result = await this.runPlan(rec, plan, outDuration > 0 ? outDuration : probe.durationSec, signal);
      if (result.code !== 0 && !result.aborted && plan.fastPath) {
        console.warn(`[jobs] ${input.id} fast-path failed, falling back to transcode: ${result.tail.slice(-1)[0] ?? ''}`);
        await fsp.rm(plan.outputPath, { force: true }).catch(() => undefined);
        plan = planFor(true);
        result = await this.runPlan(rec, plan, outDuration > 0 ? outDuration : probe.durationSec, signal);
      }
      this.throwIfAborted(rec);
      if (result.code !== 0) throw new UserError(describeFfmpegFailure(result.tail));

      const stat = await fsp.stat(plan.outputPath).catch(() => null);
      if (!stat || stat.size === 0) throw new UserError('Hasil konversi kosong. Periksa rentang trimming atau file sumber.');

      rec.outputPath = plan.outputPath;
      rec.outputName = `${safeFileBase(title)}.${plan.ext}`;
      rec.outputSize = stat.size;
      rec.status = 'ready';
      rec.progress = 100;
      rec.finishedAt = Date.now();
      rec.expiresAt = rec.finishedAt + cfg.fileTtlMinutes * 60 * 1000;
      console.log(
        `[jobs] ${input.id} ready in ${rec.finishedAt - (rec.startedAt ?? rec.finishedAt)}ms (${plan.summary})`,
      );
    } catch (err) {
      if (rec.status === 'cancelled') return;
      rec.status = 'error';
      rec.progress = null;
      rec.finishedAt = Date.now();
      if (rec.timedOut) {
        rec.error = `Proses melebihi batas waktu ${cfg.jobTimeoutMinutes} menit dan dihentikan.`;
      } else {
        rec.error = toUserMessage(err);
        if (!(err instanceof UserError)) console.error(`[jobs] ${input.id} failed`, err);
      }
      await fsp.rm(rec.dir, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      clearTimeout(timeout);
      // Free disk space early: the source is no longer needed once the output exists.
      if (sourcePath && rec.status === 'ready' && sourcePath !== rec.outputPath) {
        await fsp.rm(sourcePath, { force: true }).catch(() => undefined);
      }
    }
  }

  private async runPlan(rec: JobRecord, plan: ConvertPlan, duration: number | null, signal: AbortSignal) {
    rec.fastPath = plan.fastPath;
    rec.status = plan.fastPath ? 'extracting' : 'converting';
    rec.progress = duration ? 0 : null;
    return runFfmpeg(
      this.cfg,
      plan,
      duration,
      (p) => {
        if (rec.status === 'extracting' || rec.status === 'converting') rec.progress = p;
      },
      signal,
    );
  }

  private throwIfAborted(rec: JobRecord) {
    if (rec.controller.signal.aborted) throw new UserError('Dibatalkan.', 499);
  }

  /** Periodic cleanup: expire outputs older than FILE_TTL_MINUTES, drop stale records, remove orphan dirs. */
  async sweep(): Promise<void> {
    await this.ready;
    const now = Date.now();
    const ttlMs = this.cfg.fileTtlMinutes * 60 * 1000;

    for (const [id, rec] of this.jobs) {
      if (rec.status === 'ready' && rec.expiresAt !== null && rec.expiresAt <= now) {
        rec.status = 'expired';
        rec.progress = null;
        rec.outputPath = null;
        await fsp.rm(rec.dir, { recursive: true, force: true }).catch(() => undefined);
      } else if (!isActiveStatus(rec.status) && rec.status !== 'ready') {
        const ref = rec.finishedAt ?? rec.createdAt;
        if (ref + RECORD_RETENTION_MS <= now) this.jobs.delete(id);
      }
    }

    // Uploads that never completed.
    for (const [id, at] of this.reserved) {
      if (at + ttlMs <= now) await this.release(id);
    }

    // Orphan directories (e.g. created by a crashed process).
    const root = this.cfg.storageDir;
    const entries = await fsp.readdir(root).catch(() => [] as string[]);
    for (const name of entries) {
      if (!JOB_DIR_PATTERN.test(name) || this.reserved.has(name)) continue;
      const rec = this.jobs.get(name);
      if (rec && (rec.status === 'ready' || isActiveStatus(rec.status))) continue;
      const full = path.join(/*turbopackIgnore: true*/ root, name);
      const st = await fsp.stat(full).catch(() => null);
      if (st && st.mtimeMs + ttlMs <= now) await fsp.rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }

}

export function getJobManager(): JobManager {
  const g = globalThis as unknown as { __omcJobManager?: JobManager };
  g.__omcJobManager ??= new JobManager();
  return g.__omcJobManager;
}
