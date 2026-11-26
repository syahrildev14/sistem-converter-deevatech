import type { NextRequest } from 'next/server';
import { guardApi, handleApiError, isJobId, json, jsonError } from '@/lib/api';
import { UserError } from '@/lib/errors';
import { getJobManager } from '@/lib/jobs';
import { validateSourceUrl } from '@/lib/url';
import { parseJobParams } from '@/lib/validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_IDS = 100;

function parseIds(raw: unknown): string[] {
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : [];
  const ids = list.filter(isJobId);
  return Array.from(new Set(ids)).slice(0, MAX_IDS);
}

/** GET /api/jobs?ids=a,b,c — status of the given jobs (the browser keeps its own history of ids). */
export async function GET(req: NextRequest) {
  const denied = guardApi(req);
  if (denied) return denied;
  const ids = parseIds(req.nextUrl.searchParams.get('ids') ?? '');
  const manager = getJobManager();
  return json({ ...manager.list(ids), stats: manager.stats() });
}

/** POST /api/jobs — create a job from a source URL. */
export async function POST(req: NextRequest) {
  const denied = guardApi(req, { mutating: true });
  if (denied) return denied;
  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') throw new UserError('Body permintaan tidak valid.');
    const params = parseJobParams(body);
    const url = await validateSourceUrl(body.url);
    const manager = getJobManager();
    const { id } = await manager.reserve();
    const job = manager.submit({ id, source: { type: 'url', url }, ...params });
    return json({ job }, 201);
  } catch (err) {
    return handleApiError(err);
  }
}

/** DELETE /api/jobs — body {ids: string[]}: cancel + delete files of the given jobs ("Bersihkan"). */
export async function DELETE(req: NextRequest) {
  const denied = guardApi(req, { mutating: true });
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = parseIds(body?.ids);
  if (ids.length === 0) return jsonError('Tidak ada job yang dipilih.', 400);
  const manager = getJobManager();
  let removed = 0;
  for (const id of ids) if (await manager.remove(id)) removed++;
  return json({ removed });
}
