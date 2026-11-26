import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySessionToken } from './auth';
import { UserError } from './errors';

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Auth + CSRF guard for API routes. Mutating requests must carry the custom `x-omc: 1` header,
 * which a cross-site form cannot send without a CORS preflight.
 */
export function guardApi(req: NextRequest, opts: { mutating?: boolean } = {}): NextResponse | null {
  if (!verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) {
    return jsonError('Sesi tidak valid atau sudah berakhir. Silakan login kembali.', 401);
  }
  if (opts.mutating && req.headers.get('x-omc') !== '1') {
    return jsonError('Permintaan ditolak (header tidak valid).', 403);
  }
  return null;
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof UserError) return jsonError(err.message, err.status);
  console.error('[api] unexpected error', err);
  return jsonError('Terjadi kesalahan internal. Coba lagi atau hubungi admin.', 500);
}

/**
 * Client IP for login rate limiting. Prefers X-Real-IP (set by the reverse proxy from the TCP peer),
 * then the LAST X-Forwarded-For entry (appended by our proxy). The first X-Forwarded-For entry is
 * client-controlled and must not be trusted.
 */
export function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const parts = fwd.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return 'unknown';
}

const JOB_ID = /^j[a-f0-9]{24}$/;

export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID.test(value);
}
