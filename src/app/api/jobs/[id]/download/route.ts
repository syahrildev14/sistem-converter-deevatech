import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { guardApi, isJobId, jsonError } from '@/lib/api';
import { contentDisposition, extensionOf } from '@/lib/filename';
import { getJobManager } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mka: 'audio/x-matroska',
  ac3: 'audio/ac3',
  eac3: 'audio/eac3',
  mp2: 'audio/mpeg',
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const denied = guardApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isJobId(id)) return jsonError('ID job tidak valid.', 400);

  const file = getJobManager().getDownload(id);
  if (!file) return jsonError('File tidak tersedia (belum selesai, sudah dihapus, atau kedaluwarsa).', 404);

  const stat = await fs.promises.stat(file.path).catch(() => null);
  if (!stat) return jsonError('File sudah dihapus dari server.', 410);

  const stream = Readable.toWeb(fs.createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
  return new Response(stream, {
    headers: {
      'Content-Type': MIME[extensionOf(file.name)] ?? 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'private, no-store',
    },
  });
}
