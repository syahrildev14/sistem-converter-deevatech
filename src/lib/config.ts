import os from 'node:os';
import path from 'node:path';

export interface AppConfig {
  storageDir: string;
  fileTtlMinutes: number;
  maxUploadMb: number;
  maxDurationMinutes: number;
  maxConcurrentJobs: number;
  maxQueuedJobs: number;
  jobTimeoutMinutes: number;
  ffmpegThreads: number;
  videoPreset: string;
  maxVideoHeight: number;
  mp3AlgorithmQuality: number;

  accessPin: string;
  authSecret: string;
  sessionHours: number;
  cookieSecure: boolean;

  ffmpegPath: string;
  ffprobePath: string;
  ytdlpPath: string;
  ytdlpJsRuntimes: string;
  ytdlpCookiesFile: string;
  urlSourceEnabled: boolean;
  allowedUrlHosts: string[];
  allowPrivateUrls: boolean;
}

const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'];

function str(name: string, def = ''): string {
  const v = process.env[name];
  return v === undefined ? def : v.trim();
}

function int(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;

  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // Hard limit: at most 2 conversions at once so the CPU never gets oversubscribed.
  const maxConcurrentJobs = int('MAX_CONCURRENT_JOBS', 2, 1, 2);
  const defaultThreads = Math.max(1, Math.floor(cpus / maxConcurrentJobs));
  const preset = str('VIDEO_PRESET', 'veryfast').toLowerCase();

  cached = {
    storageDir: path.resolve(/*turbopackIgnore: true*/ str('STORAGE_DIR') || path.join(/*turbopackIgnore: true*/ os.tmpdir(), 'office-media-converter')),
    fileTtlMinutes: int('FILE_TTL_MINUTES', 30, 1, 24 * 60),
    maxUploadMb: int('MAX_UPLOAD_MB', 500, 1, 20_000),
    maxDurationMinutes: int('MAX_DURATION_MINUTES', 180, 1, 24 * 60),
    maxConcurrentJobs,
    maxQueuedJobs: int('MAX_QUEUED_JOBS', 20, 1, 500),
    jobTimeoutMinutes: int('JOB_TIMEOUT_MINUTES', 30, 1, 24 * 60),
    ffmpegThreads: int('FFMPEG_THREADS', defaultThreads, 1, 64),
    videoPreset: X264_PRESETS.includes(preset) ? preset : 'veryfast',
    maxVideoHeight: int('MAX_VIDEO_HEIGHT', 720, 144, 4320),
    mp3AlgorithmQuality: int('MP3_ALGORITHM_QUALITY', 5, 0, 9),

    accessPin: str('ACCESS_PIN'),
    authSecret: str('AUTH_SECRET'),
    sessionHours: int('SESSION_HOURS', 12, 1, 24 * 30),
    cookieSecure: bool('COOKIE_SECURE', false),

    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg') || 'ffmpeg',
    ffprobePath: str('FFPROBE_PATH', 'ffprobe') || 'ffprobe',
    ytdlpPath: str('YTDLP_PATH', 'yt-dlp') || 'yt-dlp',
    ytdlpJsRuntimes: str('YTDLP_JS_RUNTIMES'),
    ytdlpCookiesFile: str('YTDLP_COOKIES_FILE'),
    urlSourceEnabled: bool('ENABLE_URL_SOURCE', true),
    allowedUrlHosts: str('ALLOWED_URL_HOSTS')
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/^\*\./, ''))
      .filter(Boolean),
    allowPrivateUrls: bool('ALLOW_PRIVATE_URLS', false),
  };
  return cached;
}
