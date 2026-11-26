import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, isAuthEnabled, verifySessionToken } from '@/lib/auth';

/**
 * Page protection (Next.js 16 "proxy", formerly middleware). API routes are excluded from the matcher
 * on purpose: they verify the session themselves, and skipping the proxy keeps large uploads streaming
 * directly to disk instead of being buffered.
 */
export function proxy(req: NextRequest) {
  if (!isAuthEnabled()) return NextResponse.next();
  if (verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  if (req.nextUrl.pathname !== '/') url.searchParams.set('next', req.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!api/|login|_next/static|_next/image|favicon.ico|icon|apple-icon).*)'],
};
