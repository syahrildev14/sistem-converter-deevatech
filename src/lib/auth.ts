import crypto from 'node:crypto';
import { getConfig } from './config';

export const SESSION_COOKIE = 'omc_session';

export function isAuthEnabled(): boolean {
  return getConfig().accessPin.length > 0;
}

function signingKey(): Buffer {
  const cfg = getConfig();
  // Including the PIN means rotating ACCESS_PIN invalidates all existing sessions.
  return crypto.createHash('sha256').update(`omc|${cfg.authSecret}|${cfg.accessPin}`).digest();
}

function sign(value: string): string {
  return crypto.createHmac('sha256', signingKey()).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = crypto.createHash('sha256').update(a).digest();
  const bb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ab, bb) && a.length === b.length;
}

export function createSessionToken(): { token: string; maxAge: number } {
  const maxAge = getConfig().sessionHours * 3600;
  const exp = Math.floor(Date.now() / 1000) + maxAge;
  return { token: `${exp}.${sign(String(exp))}`, maxAge };
}

/** Returns true when auth is disabled or the token is a valid, unexpired session. */
export function verifySessionToken(token: string | null | undefined): boolean {
  if (!isAuthEnabled()) return true;
  if (!token) return false;
  const [exp, sig, extra] = token.split('.');
  if (!exp || !sig || extra !== undefined || !/^\d{1,12}$/.test(exp)) return false;
  if (Number(exp) * 1000 < Date.now()) return false;
  return safeEqual(sig, sign(exp));
}

export function verifyPin(pin: unknown): boolean {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > 256) return false;
  return safeEqual(pin, getConfig().accessPin);
}

// --- Simple in-memory login rate limiting (per client IP) ---
interface Attempt {
  count: number;
  resetAt: number;
}
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function attempts(): Map<string, Attempt> {
  const g = globalThis as unknown as { __omcLoginAttempts?: Map<string, Attempt> };
  g.__omcLoginAttempts ??= new Map();
  return g.__omcLoginAttempts;
}

export function isLoginBlocked(ip: string): boolean {
  const a = attempts().get(ip);
  return !!a && a.resetAt > Date.now() && a.count >= MAX_ATTEMPTS;
}

export function recordLoginFailure(ip: string): void {
  const map = attempts();
  const now = Date.now();
  const a = map.get(ip);
  if (!a || a.resetAt <= now) map.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  else a.count++;
  if (map.size > 1000) {
    for (const [k, v] of map) if (v.resetAt <= now) map.delete(k);
  }
}

export function clearLoginFailures(ip: string): void {
  attempts().delete(ip);
}
