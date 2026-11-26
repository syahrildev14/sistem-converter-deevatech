import { getConfig } from '@/lib/config';
import { getJobManager } from '@/lib/jobs';
import { runProcess } from '@/lib/process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface BinaryState {
  checkedAt: number;
  ffmpeg: boolean;
  ytdlp: boolean;
}

const CHECK_TTL_MS = 5 * 60 * 1000;

async function check(cmd: string, args: string[]): Promise<boolean> {
  try {
    const res = await runProcess(cmd, args, { signal: AbortSignal.timeout(10_000) });
    return res.code === 0;
  } catch {
    return false;
  }
}

async function binaries(): Promise<BinaryState> {
  const g = globalThis as unknown as { __omcBinaries?: BinaryState };
  if (g.__omcBinaries && g.__omcBinaries.checkedAt + CHECK_TTL_MS > Date.now()) return g.__omcBinaries;
  const cfg = getConfig();
  const [ffmpeg, ytdlp] = await Promise.all([
    check(cfg.ffmpegPath, ['-hide_banner', '-version']),
    cfg.urlSourceEnabled ? check(cfg.ytdlpPath, ['--version']) : Promise.resolve(true),
  ]);
  g.__omcBinaries = { checkedAt: Date.now(), ffmpeg, ytdlp };
  return g.__omcBinaries;
}

/** Unauthenticated health endpoint for Docker / load balancers. Exposes no job data. */
export async function GET() {
  const bin = await binaries();
  const ok = bin.ffmpeg;
  return Response.json(
    { ok, ffmpeg: bin.ffmpeg, ytdlp: bin.ytdlp, jobs: getJobManager().stats(), uptimeSec: Math.round(process.uptime()) },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
