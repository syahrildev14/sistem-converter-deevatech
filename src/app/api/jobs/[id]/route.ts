import type { NextRequest } from 'next/server';
import { guardApi, isJobId, json, jsonError } from '@/lib/api';
import { getJobManager } from '@/lib/jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const denied = guardApi(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isJobId(id)) return jsonError('ID job tidak valid.', 400);
  const job = getJobManager().get(id);
  return job ? json({ job }) : jsonError('Job tidak ditemukan atau sudah kedaluwarsa.', 404);
}

/** DELETE /api/jobs/:id — cancel (active) or delete (finished) a job. ?mode=cancel keeps the record. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const denied = guardApi(req, { mutating: true });
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!isJobId(id)) return jsonError('ID job tidak valid.', 400);
  const manager = getJobManager();
  if (req.nextUrl.searchParams.get('mode') === 'cancel') {
    const job = await manager.cancel(id);
    return job ? json({ job }) : jsonError('Job tidak ditemukan.', 404);
  }
  const removed = await manager.remove(id);
  return removed ? json({ removed: true }) : jsonError('Job tidak ditemukan.', 404);
}
