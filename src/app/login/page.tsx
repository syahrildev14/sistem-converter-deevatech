import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppLogo } from '@/components/AppLogo';
import { LoginForm } from '@/components/LoginForm';
import { SESSION_COOKIE, isAuthEnabled, verifySessionToken } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  // Only allow same-site relative redirects.
  const target = typeof next === 'string' && /^\/(?!\/)[\w\-/]*$/.test(next) ? next : '/';

  if (!isAuthEnabled()) redirect(target);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token)) redirect(target);

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-5 flex items-center gap-3">
          <AppLogo />
          <div>
            <h1 className="font-semibold">Office Media Converter</h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">Akses khusus tim internal</p>
          </div>
        </div>
        <LoginForm next={target} />
      </div>
    </main>
  );
}
