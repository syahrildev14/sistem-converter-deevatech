import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { NextRequest } from 'next/server';
import { guardApi, handleApiError, json } from '@/lib/api';
import { getConfig } from '@/lib/config';
import { UserError } from '@/lib/errors';
import { extensionOf } from '@/lib/filename';
import { getJobManager } from '@/lib/jobs';
import { ALLOWED_UPLOAD_EXTENSIONS } from '@/lib/types';
import { parseJobParams } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/jobs/upload?name=…&format=…&start=…&end=…&title=…
 * Body: the raw file bytes (application/octet-stream). Streamed straight to disk — never buffered in RAM.
 */
export async function POST(req: NextRequest) {
  const denied = guardApi(req, { mutating: true });
  if (denied) return denied;

  const cfg = getConfig();
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  let reservedId: string | null = null;
  const manager = getJobManager();

  try {
    const q = req.nextUrl.searchParams;
    const params = parseJobParams({
      format: q.get('format'),
      start: q.get('start') ?? undefined,
      end: q.get('end') ?? undefined,
      title: q.get('title') ?? undefined,
    });

    const originalName = (q.get('name') ?? '').trim().slice(0, 255);
    const ext = extensionOf(originalName);
    if (!originalName || !ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
      throw new UserError(`Tipe file tidak didukung. Gunakan: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}.`, 415);
    }

    const declared = Number(req.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new UserError(`Ukuran file melebihi batas ${cfg.maxUploadMb} MB.`, 413);
    if (!req.body) throw new UserError('File kosong.');

    const { id, dir } = await manager.reserve();
    reservedId = id;
    const dest = path.join(/*turbopackIgnore: true*/ dir, `upload.${ext}`);

    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > maxBytes) cb(new UserError(`Ukuran file melebihi batas ${cfg.maxUploadMb} MB.`, 413));
        else cb(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(req.body as unknown as NodeWebReadableStream<Uint8Array>),
        limiter,
        fs.createWriteStream(dest),
      );
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError('Upload terputus atau gagal. Coba lagi.', 400);
    }
    if (received === 0) throw new UserError('File kosong.');

    const job = manager.submit({ id, source: { type: 'upload', path: dest, originalName }, ...params });
    reservedId = null;
    return json({ job }, 201);
  } catch (err) {
    if (reservedId) await manager.release(reservedId);
    return handleApiError(err);
  }
}
