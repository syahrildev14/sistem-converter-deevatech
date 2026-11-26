import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppLogo } from '@/components/AppLogo';
import { Converter } from '@/components/Converter';
import { LogoutButton } from '@/components/LogoutButton';
import { SESSION_COOKIE, isAuthEnabled, verifySessionToken } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { ALLOWED_UPLOAD_EXTENSIONS, type ClientLimits } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const authEnabled = isAuthEnabled();
  if (authEnabled) {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!verifySessionToken(token)) redirect('/login');
  }

  const cfg = getConfig();
  const limits: ClientLimits = {
    maxUploadMb: cfg.maxUploadMb,
    maxDurationMinutes: cfg.maxDurationMinutes,
    fileTtlMinutes: cfg.fileTtlMinutes,
    maxConcurrentJobs: cfg.maxConcurrentJobs,
    urlSourceEnabled: cfg.urlSourceEnabled,
    authEnabled,
    allowedUploadExtensions: ALLOWED_UPLOAD_EXTENSIONS,
  };

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 sm:py-10">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <AppLogo />
          <div>
            <h1 className="text-lg font-semibold leading-tight sm:text-xl">Office Media Converter</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Internal · maks. {limits.maxUploadMb} MB / {limits.maxDurationMinutes} menit · file dihapus otomatis setelah{' '}
              {limits.fileTtlMinutes} menit
            </p>
          </div>
        </div>
        {authEnabled && <LogoutButton />}
      </header>
      <Converter limits={limits} />
    </main>
  );
}
