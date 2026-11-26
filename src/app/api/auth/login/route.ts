import type { NextRequest } from 'next/server';
import { clientIp, json, jsonError } from '@/lib/api';
import {
  SESSION_COOKIE,
  clearLoginFailures,
  createSessionToken,
  isAuthEnabled,
  isLoginBlocked,
  recordLoginFailure,
  verifyPin,
} from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  if (req.headers.get('x-omc') !== '1') return jsonError('Permintaan ditolak.', 403);
  if (!isAuthEnabled()) return json({ ok: true });

  const ip = clientIp(req);
  if (isLoginBlocked(ip)) return jsonError('Terlalu banyak percobaan login. Coba lagi dalam 10 menit.', 429);

  const body = (await req.json().catch(() => null)) as { pin?: unknown } | null;
  if (!verifyPin(body?.pin)) {
    recordLoginFailure(ip);
    // Small constant delay slows down guessing.
    await new Promise((r) => setTimeout(r, 400));
    return jsonError('PIN / password salah.', 401);
  }

  clearLoginFailures(ip);
  const { token, maxAge } = createSessionToken();
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: getConfig().cookieSecure,
    path: '/',
    maxAge,
  });
  return res;
}
