import type { NextRequest } from 'next/server';
import { json, jsonError } from '@/lib/api';
import { SESSION_COOKIE } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-omc') !== '1') return jsonError('Permintaan ditolak.', 403);
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: getConfig().cookieSecure,
    path: '/',
    maxAge: 0,
  });
  return res;
}
