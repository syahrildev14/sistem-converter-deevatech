'use client';

import { useEffect, useState } from 'react';
import { formatBytes, formatDuration } from '@/lib/time';
import { FORMAT_INFO, isActiveStatus, type JobStatus, type JobView } from '@/lib/types';

const STATUS_STYLE: Record<JobStatus, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  fetching: { label: 'Mengambil sumber', className: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300' },
  extracting: { label: 'Extracting', className: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300' },
  converting: { label: 'Converting', className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  ready: { label: 'Ready', className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' },
  error: { label: 'Gagal', className: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300' },
  cancelled: { label: 'Dibatalkan', className: 'bg-slate-200 text-slate-600 dark:bg-slate-800 dark:text-slate-400' },
  expired: { label: 'Expired', className: 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500' },
};

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function effectiveStatus(job: JobView, now: number): JobStatus {
  if (job.status === 'ready' && job.expiresAt !== null && job.expiresAt <= now) return 'expired';
  return job.status;
}

function relativeMinutes(ms: number): string {
  const min = Math.max(0, Math.ceil(ms / 60000));
  return min <= 1 ? '< 1 mnt' : `${min} mnt`;
}

interface Props {
  jobs: JobView[];
  onCancel: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}

export function JobList({ jobs, onCancel, onDelete, onClearAll }: Props) {
  const now = useNow(1000);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold">Riwayat konversi</h2>
        {jobs.length > 0 && (
          <button
            type="button"
            onClick={onClearAll}
            className="rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-800"
          >
            Bersihkan semua
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
          Belum ada konversi. Masukkan URL atau upload file di atas.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {jobs.map((job) => {
            const status = effectiveStatus(job, now);
            const style = STATUS_STYLE[status];
            const active = isActiveStatus(status);
            const elapsed = job.startedAt ? (job.finishedAt ?? now) - job.startedAt : null;
            return (
              <li key={job.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}>
                        {style.label}
                        {status === 'queued' && job.queuePosition ? ` #${job.queuePosition}` : ''}
                      </span>
                      <span className="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
                        {FORMAT_INFO[job.format].short}
                      </span>
                      {job.fastPath && (status === 'extracting' || status === 'ready') && (
                        <span
                          className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                          title="Stream copy tanpa re-encode"
                        >
                          ⚡ fast-path
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm font-medium" title={job.outputName ?? job.title ?? job.sourceLabel}>
                      {job.outputName ?? job.title ?? job.sourceLabel}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {job.sourceType === 'url' ? '🔗' : '📁'} {job.sourceLabel}
                      {(job.trim.startSec !== null || job.trim.endSec !== null) &&
                        ` · ✂ ${formatDuration(job.trim.startSec ?? 0)}–${job.trim.endSec !== null ? formatDuration(job.trim.endSec) : 'akhir'}`}
                      {job.mediaDurationSec !== null && ` · ${formatDuration(job.mediaDurationSec)}`}
                      {job.outputSize !== null && ` · ${formatBytes(job.outputSize)}`}
                      {elapsed !== null && status !== 'expired' && ` · ${(elapsed / 1000).toFixed(1)} dtk`}
                      {status === 'ready' && job.expiresAt !== null && ` · hapus otomatis ${relativeMinutes(job.expiresAt - now)} lagi`}
                    </p>
                    {status === 'error' && job.error && (
                      <p className="mt-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">
                        {job.error}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {status === 'ready' && (
                      <a
                        href={`/api/jobs/${job.id}/download`}
                        download={job.outputName ?? undefined}
                        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500"
                      >
                        Download
                      </a>
                    )}
                    {active ? (
                      <button
                        type="button"
                        onClick={() => onCancel(job.id)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        Batal
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onDelete(job.id)}
                        title="Hapus dari riwayat & server"
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 hover:text-red-600 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                      >
                        Hapus
                      </button>
                    )}
                  </div>
                </div>

                {active && (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                    {job.progress !== null && status !== 'queued' ? (
                      <div
                        className="h-full rounded-full bg-indigo-600 transition-[width] duration-500"
                        style={{ width: `${Math.max(3, job.progress)}%` }}
                      />
                    ) : (
                      <div
                        className={`progress-indeterminate h-full rounded-full ${status === 'queued' ? 'bg-slate-400' : 'bg-indigo-600'}`}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
