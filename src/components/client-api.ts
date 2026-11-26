'use client';

import type { JobView } from '@/lib/types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function onUnauthorized(): never {
  window.location.href = '/login';
  throw new ApiError('Sesi berakhir, silakan login kembali.', 401);
}

async function errorFrom(res: Response): Promise<ApiError> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return new ApiError(data?.error ?? `Permintaan gagal (HTTP ${res.status}).`, res.status);
}

export async function apiJson<T>(input: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-omc', '1');
  if (typeof init.body === 'string') headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetch(input, { ...init, headers, cache: 'no-store' });
  } catch {
    throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi.', 0);
  }
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as T;
}

export interface UploadParams {
  format: string;
  start: string;
  end: string;
  title: string;
}

/** Uploads a file as a raw body (streamed to disk server-side) with progress reporting. */
export function uploadFile(
  file: File,
  params: UploadParams,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<JobView> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ name: file.name, format: params.format });
    if (params.start) qs.set('start', params.start);
    if (params.end) qs.set('end', params.end);
    if (params.title) qs.set('title', params.title);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/jobs/upload?${qs.toString()}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-omc', '1');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const body = xhr.response as { job?: JobView; error?: string } | null;
      if (xhr.status === 401) {
        window.location.href = '/login';
        reject(new ApiError('Sesi berakhir, silakan login kembali.', 401));
      } else if (xhr.status >= 200 && xhr.status < 300 && body?.job) {
        resolve(body.job);
      } else {
        reject(new ApiError(body?.error ?? `Upload gagal (HTTP ${xhr.status}).`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError('Upload gagal: koneksi terputus.', 0));
    xhr.onabort = () => reject(new ApiError('Upload dibatalkan.', 0));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
