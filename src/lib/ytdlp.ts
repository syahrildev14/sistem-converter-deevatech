import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from './config';
import { UserError } from './errors';
import { runProcess } from './process';
import type { OutputFormat } from './types';

export interface DownloadResult {
  filePath: string;
  title: string | null;
  durationSec: number | null;
}

/**
 * Picks a yt-dlp format selector that lets ffmpeg use the fast path afterwards:
 *  - MP4: prefer H.264 + AAC so the result can be remuxed without re-encoding.
 *  - M4A / Audio Copy: prefer an AAC (m4a) audio stream so it can be stream-copied.
 *  - MP3 / WAV: smallest work = best audio-only stream (no video download at all).
 */
function formatSelector(format: OutputFormat, maxHeight: number): string {
  if (format === 'mp4') {
    const h = `[height<=${maxHeight}]`;
    return `bv*[vcodec^=avc1]${h}+ba[ext=m4a]/b[ext=mp4]${h}/bv*${h}+ba/b${h}/b`;
  }
  if (format === 'm4a' || format === 'audio-copy') return 'ba[ext=m4a]/ba/b';
  return 'ba/b';
}

function describeYtdlpFailure(lines: string[]): string {
  const text = lines.join('\n');
  const rules: [RegExp, string][] = [
    [/Requested format is not available/i, 'Format yang dibutuhkan tidak tersedia pada sumber ini. Coba format output lain.'],
    [/Unsupported URL/i, 'URL tidak didukung oleh pengambil media. Pastikan URL menuju halaman video/audio yang valid.'],
    [/Private video|members-only|This video is private/i, 'Media bersifat privat / khusus member sehingga tidak bisa diambil.'],
    [/Video unavailable|has been removed|is not available|HTTP Error 404/i, 'Media tidak tersedia (dihapus, dibatasi wilayah, atau URL salah).'],
    [/Sign in to confirm|confirm you.re not a bot|login required|requires authentication/i,
      'Sumber meminta login / verifikasi bot. Admin bisa mengatur YTDLP_COOKIES_FILE.'],
    [/age[- ]?restricted|confirm your age/i, 'Media dibatasi usia dan memerlukan login (cookies).'],
    [/does not pass filter|live event|is live/i, 'Media melebihi batas durasi atau merupakan siaran live.'],
    [/larger than max-filesize/i, 'Ukuran media melebihi batas maksimal server.'],
    [/HTTP Error 403|Forbidden/i, 'Akses ke sumber ditolak (HTTP 403). Coba lagi nanti atau gunakan upload file.'],
    [/HTTP Error 429|Too Many Requests/i, 'Sumber membatasi permintaan (HTTP 429). Coba beberapa menit lagi.'],
    [/timed out|Connection reset|Unable to download webpage|getaddrinfo|Name or service not known/i,
      'Gagal terhubung ke sumber (timeout / jaringan). Periksa URL atau koneksi server.'],
    [/No space left on device/i, 'Penyimpanan server penuh. Hubungi admin.'],
  ];
  for (const [re, msg] of rules) if (re.test(text)) return msg;
  const err = lines.filter((l) => /^ERROR:/i.test(l)).pop() ?? lines.filter((l) => l.trim()).pop();
  return `Gagal mengambil media dari URL${err ? `: ${err.replace(/^ERROR:\s*/i, '').slice(0, 300)}` : '.'}`;
}

export async function downloadFromUrl(
  cfg: AppConfig,
  url: string,
  format: OutputFormat,
  dir: string,
  signal: AbortSignal,
  onProgress: (pct: number) => void,
): Promise<DownloadResult> {
  const maxDurationSec = cfg.maxDurationMinutes * 60;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--no-mtime',
    '--no-cache-dir',
    '--newline',
    '--progress',
    '--progress-template', 'download:__PROG__%(progress._percent_str)s',
    '--print', 'before_dl:__TITLE__%(title)s',
    '--print', 'before_dl:__DUR__%(duration)s',
    '--print', 'after_move:__FILE__%(filepath)s',
    '--no-simulate',
    '--socket-timeout', '20',
    '--retries', '3',
    '--fragment-retries', '3',
    '--concurrent-fragments', '4',
    '--max-filesize', `${cfg.maxUploadMb}M`,
    '--match-filter', `!is_live & duration <=? ${maxDurationSec}`,
    '-f', formatSelector(format, cfg.maxVideoHeight),
    '-o', path.join(/*turbopackIgnore: true*/ dir, 'source.%(ext)s'),
  ];
  if (format === 'mp4') args.push('--merge-output-format', 'mp4');
  if (cfg.ytdlpJsRuntimes) args.push('--js-runtimes', cfg.ytdlpJsRuntimes);
  if (cfg.ytdlpCookiesFile) args.push('--cookies', cfg.ytdlpCookiesFile);
  // "--" guarantees the URL is never parsed as an option.
  args.push('--', url);

  const meta: { title: string | null; durationSec: number | null; filePath: string | null } = {
    title: null,
    durationSec: null,
    filePath: null,
  };
  const lines: string[] = [];
  let last = -1;

  const handle = (line: string) => {
    if (line.startsWith('__PROG__')) {
      const pct = Number.parseFloat(line.slice(8));
      if (Number.isFinite(pct)) {
        const p = Math.min(100, Math.max(0, Math.floor(pct)));
        if (p !== last) {
          last = p;
          onProgress(p);
        }
      }
      return;
    }
    if (line.startsWith('__TITLE__')) {
      const t = line.slice(9).trim();
      meta.title = t && t !== 'NA' ? t : null;
      return;
    }
    if (line.startsWith('__DUR__')) {
      const d = Number.parseFloat(line.slice(7));
      meta.durationSec = Number.isFinite(d) && d > 0 ? d : null;
      return;
    }
    if (line.startsWith('__FILE__')) {
      meta.filePath = line.slice(8).trim();
      return;
    }
    lines.push(line);
    if (lines.length > 60) lines.shift();
  };

  const res = await runProcess(cfg.ytdlpPath, args, { signal, onStdoutLine: handle, onStderrLine: handle });
  if (res.aborted) throw new UserError('Dibatalkan.', 499);

  let filePath = meta.filePath;
  if (!filePath) {
    // Fallback: locate the downloaded file in the job directory.
    const entries = await fsp.readdir(dir).catch(() => [] as string[]);
    const found = entries.find((e) => e.startsWith('source.') && !e.endsWith('.part') && !e.endsWith('.ytdl'));
    if (found) filePath = path.join(/*turbopackIgnore: true*/ dir, found);
  }

  if (res.code !== 0 || !filePath) {
    throw new UserError(describeYtdlpFailure([...lines, ...res.tail]));
  }
  const resolved = path.resolve(/*turbopackIgnore: true*/ filePath);
  if (path.dirname(resolved) !== path.resolve(/*turbopackIgnore: true*/ dir)) {
    throw new UserError('Lokasi file hasil unduhan tidak valid.', 500);
  }
  return { filePath: resolved, title: meta.title, durationSec: meta.durationSec };
}
