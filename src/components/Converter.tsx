'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, parseTimecode } from '@/lib/time';
import {
  DEFAULT_FORMAT,
  FORMAT_INFO,
  OUTPUT_FORMATS,
  isActiveStatus,
  isOutputFormat,
  type ClientLimits,
  type JobView,
  type OutputFormat,
} from '@/lib/types';
import { ApiError, apiJson, uploadFile } from './client-api';
import { JobList } from './JobList';

const HISTORY_KEY = 'omc.history.v1';
const FORMAT_KEY = 'omc.format.v1';
const MAX_HISTORY = 30;

function loadHistory(): JobView[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as JobView[]) : [];
    return Array.isArray(parsed) ? parsed.filter((j) => j && typeof j.id === 'string').slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(jobs: JobView[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(jobs.slice(0, MAX_HISTORY)));
  } catch {
    /* storage unavailable (private mode) — history just won't persist */
  }
}

/** Jobs worth asking the server about (everything not in a final, file-less state). */
function needsPolling(job: JobView): boolean {
  return job.status !== 'expired' && job.status !== 'cancelled' && job.status !== 'error';
}

export function Converter({ limits }: { limits: ClientLimits }) {
  const [mode, setMode] = useState<'url' | 'file'>(limits.urlSourceEnabled ? 'url' : 'file');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [format, setFormat] = useState<OutputFormat>(DEFAULT_FORMAT);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [jobs, setJobs] = useState<JobView[]>([]);

  const jobsRef = useRef<JobView[]>([]);
  const hydrated = useRef(false);
  const kickRef = useRef<() => void>(() => undefined);
  const uploadAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const updateJobs = useCallback((fn: (prev: JobView[]) => JobView[]) => {
    setJobs((prev) => {
      const next = fn(prev);
      jobsRef.current = next;
      if (hydrated.current) saveHistory(next);
      return next;
    });
  }, []);

  // Hydrate history + last used format from localStorage.
  useEffect(() => {
    const history = loadHistory();
    jobsRef.current = history;
    setJobs(history);
    hydrated.current = true;
    try {
      const f = localStorage.getItem(FORMAT_KEY);
      if (isOutputFormat(f)) setFormat(f);
    } catch {
      /* ignore */
    }
  }, []);

  // Status polling: 1s while something is running, 15s otherwise (to notice expiry).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const tick = async () => {
      clearTimeout(timer);
      const ids = jobsRef.current.filter(needsPolling).map((j) => j.id);
      if (ids.length > 0 && document.visibilityState !== 'hidden') {
        try {
          const data = await apiJson<{ jobs: JobView[]; missing: string[] }>(`/api/jobs?ids=${ids.join(',')}`);
          const fresh = new Map(data.jobs.map((j) => [j.id, j]));
          const missing = new Set(data.missing);
          updateJobs((prev) =>
            prev.map((j) => {
              const f = fresh.get(j.id);
              if (f) return f;
              if (missing.has(j.id)) {
                // Server no longer knows it (expired, restarted, or deleted elsewhere).
                return isActiveStatus(j.status)
                  ? { ...j, status: 'error', progress: null, error: 'Job hilang dari server (server di-restart?).' }
                  : { ...j, status: 'expired', progress: null };
              }
              return j;
            }),
          );
        } catch {
          /* transient network error — retry on next tick */
        }
      }
      if (stopped) return;
      const active = jobsRef.current.some((j) => isActiveStatus(j.status));
      timer = setTimeout(tick, active ? 1000 : 15000);
    };

    kickRef.current = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, 300);
    };
    const onVisible = () => document.visibilityState === 'visible' && kickRef.current();
    document.addEventListener('visibilitychange', onVisible);
    timer = setTimeout(tick, 200);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [updateJobs]);

  function chooseFormat(f: OutputFormat) {
    setFormat(f);
    try {
      localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* ignore */
    }
  }

  function pickFile(f: File | null) {
    setFormError(null);
    if (!f) return setFile(null);
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    if (!limits.allowedUploadExtensions.includes(ext)) {
      setFormError(`Tipe file .${ext} tidak didukung.`);
      return;
    }
    if (f.size > limits.maxUploadMb * 1024 * 1024) {
      setFormError(`Ukuran file ${formatBytes(f.size)} melebihi batas ${limits.maxUploadMb} MB.`);
      return;
    }
    setFile(f);
  }

  function validateForm(): string | null {
    if (mode === 'url') {
      const v = url.trim();
      if (!v) return 'Masukkan URL sumber.';
      try {
        const u = new URL(v);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL harus diawali http:// atau https://';
      } catch {
        return 'Format URL tidak valid.';
      }
    } else if (!file) {
      return 'Pilih file audio/video terlebih dahulu.';
    }
    try {
      const s = parseTimecode(start, 'Waktu mulai');
      const e = parseTimecode(end, 'Waktu selesai');
      if (s !== null && e !== null && e <= s) return 'Waktu selesai harus lebih besar dari waktu mulai.';
    } catch (err) {
      return (err as Error).message;
    }
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validateForm();
    if (invalid) return setFormError(invalid);
    setFormError(null);
    setSubmitting(true);
    try {
      let job: JobView;
      if (mode === 'url') {
        const res = await apiJson<{ job: JobView }>('/api/jobs', {
          method: 'POST',
          body: JSON.stringify({ url: url.trim(), format, start, end, title }),
        });
        job = res.job;
        setUrl('');
      } else {
        const ctrl = new AbortController();
        uploadAbort.current = ctrl;
        setUploadPct(0);
        job = await uploadFile(file!, { format, start, end, title }, setUploadPct, ctrl.signal);
        setFile(null);
        if (fileInput.current) fileInput.current.value = '';
      }
      setTitle('');
      updateJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)].slice(0, MAX_HISTORY));
      kickRef.current();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Terjadi kesalahan tak terduga.');
    } finally {
      setSubmitting(false);
      setUploadPct(null);
      uploadAbort.current = null;
    }
  }

  async function cancelJob(id: string) {
    try {
      const res = await apiJson<{ job: JobView }>(`/api/jobs/${id}?mode=cancel`, { method: 'DELETE' });
      updateJobs((prev) => prev.map((j) => (j.id === id ? res.job : j)));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        updateJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: 'cancelled', progress: null } : j)));
      }
    }
  }

  async function deleteJob(id: string) {
    await apiJson(`/api/jobs/${id}`, { method: 'DELETE' }).catch(() => undefined);
    updateJobs((prev) => prev.filter((j) => j.id !== id));
  }

  async function clearAll() {
    const ids = jobsRef.current.map((j) => j.id);
    if (ids.length === 0) return;
    await apiJson('/api/jobs', { method: 'DELETE', body: JSON.stringify({ ids }) }).catch(() => undefined);
    updateJobs(() => []);
  }

  const inputCls =
    'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 dark:border-slate-700 dark:bg-slate-950';
  const isVideo = FORMAT_INFO[format].kind === 'video';

  return (
    <div className="space-y-6">
      <form
        onSubmit={onSubmit}
        className="space-y-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 dark:border-slate-800 dark:bg-slate-900"
      >
        {/* Source */}
        <div>
          <div className="mb-3 inline-flex rounded-lg bg-slate-100 p-1 text-sm dark:bg-slate-800">
            {limits.urlSourceEnabled && (
              <button
                type="button"
                onClick={() => setMode('url')}
                className={`rounded-md px-3 py-1.5 font-medium ${mode === 'url' ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-500'}`}
              >
                🔗 URL
              </button>
            )}
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`rounded-md px-3 py-1.5 font-medium ${mode === 'file' ? 'bg-white shadow-sm dark:bg-slate-950' : 'text-slate-500'}`}
            >
              📁 Upload file
            </button>
          </div>

          {mode === 'url' ? (
            <input
              type="url"
              inputMode="url"
              placeholder="https://… (link halaman video/audio)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={inputCls}
              autoComplete="off"
              spellCheck={false}
            />
          ) : (
            <label
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pickFile(e.dataTransfer.files?.[0] ?? null);
              }}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm transition ${
                dragOver
                  ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30'
                  : 'border-slate-300 hover:border-indigo-400 dark:border-slate-700'
              }`}
            >
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                accept={limits.allowedUploadExtensions.map((e) => `.${e}`).join(',')}
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <>
                  <span className="font-medium">{file.name}</span>
                  <span className="text-xs text-slate-500">{formatBytes(file.size)} · klik untuk ganti</span>
                </>
              ) : (
                <>
                  <span className="font-medium">Tarik & lepas file di sini, atau klik untuk memilih</span>
                  <span className="text-xs text-slate-500">Audio/video, maks. {limits.maxUploadMb} MB</span>
                </>
              )}
            </label>
          )}
        </div>

        {/* Output format */}
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Format output</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {OUTPUT_FORMATS.map((f) => {
              const info = FORMAT_INFO[f];
              const selected = f === format;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => chooseFormat(f)}
                  aria-pressed={selected}
                  title={info.description}
                  className={`rounded-lg border px-3 py-2 text-left transition ${
                    selected
                      ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500/30 dark:bg-indigo-950/40'
                      : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
                  }`}
                >
                  <span className="block text-sm font-semibold">{info.label}</span>
                  <span className="block text-[11px] leading-tight text-slate-500 dark:text-slate-400">{info.description}</span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {/* Advanced */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? '▾' : '▸'} Opsi lanjutan (trim & judul)
          </button>
          {showAdvanced && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                <span className="mb-1 block text-slate-600 dark:text-slate-300">Mulai (opsional)</span>
                <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="0:30" className={inputCls} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600 dark:text-slate-300">Selesai (opsional)</span>
                <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="3:45" className={inputCls} />
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-slate-600 dark:text-slate-300">Judul / nama file (opsional)</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  placeholder="Otomatis dari sumber"
                  className={inputCls}
                />
              </label>
              <p className="text-xs text-slate-500 sm:col-span-3 dark:text-slate-400">
                Format waktu: detik (90), mm:ss (1:30) atau hh:mm:ss.
                {isVideo && ' Pada MP4 mode remux, titik potong mengikuti keyframe terdekat.'} Judul kosong = diambil
                otomatis dari sumber dan dibersihkan (mis. tag “(Official Video)” dihapus).
              </p>
            </div>
          )}
        </div>

        {formError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300" role="alert">
            {formError}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-60"
          >
            {submitting ? (uploadPct !== null ? `Mengupload… ${uploadPct}%` : 'Memproses…') : 'Konversi sekarang'}
          </button>
          {uploadPct !== null && (
            <button
              type="button"
              onClick={() => uploadAbort.current?.abort()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Batalkan upload
            </button>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Maks. {limits.maxConcurrentJobs} konversi berjalan bersamaan, sisanya antre otomatis.
          </span>
        </div>
        {uploadPct !== null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div className="h-full bg-indigo-600 transition-[width]" style={{ width: `${uploadPct}%` }} />
          </div>
        )}
      </form>

      <JobList jobs={jobs} onCancel={cancelJob} onDelete={deleteJob} onClearAll={clearAll} />
    </div>
  );
}
