// Shared (client + server) types and constants. Must not import Node modules.

export const OUTPUT_FORMATS = [
  'mp3-128',
  'mp3-192',
  'mp3-320',
  'm4a',
  'wav',
  'audio-copy',
  'mp4',
] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface FormatInfo {
  label: string;
  short: string;
  description: string;
  kind: 'audio' | 'video';
}

export const FORMAT_INFO: Record<OutputFormat, FormatInfo> = {
  'mp3-128': {
    label: 'MP3 128 kbps',
    short: 'MP3 128k',
    description: 'Paling cepat & kecil, cukup untuk suara/podcast',
    kind: 'audio',
  },
  'mp3-192': {
    label: 'MP3 192 kbps',
    short: 'MP3 192k',
    description: 'Seimbang kualitas & ukuran (default)',
    kind: 'audio',
  },
  'mp3-320': {
    label: 'MP3 320 kbps',
    short: 'MP3 320k',
    description: 'Kualitas MP3 tertinggi',
    kind: 'audio',
  },
  m4a: {
    label: 'M4A / AAC',
    short: 'M4A',
    description: 'Copy langsung bila sumber sudah AAC, selain itu AAC 192k',
    kind: 'audio',
  },
  wav: {
    label: 'WAV (PCM)',
    short: 'WAV',
    description: 'Tanpa kompresi, untuk editing — file besar',
    kind: 'audio',
  },
  'audio-copy': {
    label: 'Audio Copy ⚡',
    short: 'Audio Copy',
    description: 'Ekstrak audio asli tanpa re-encode (tercepat, codec sesuai sumber)',
    kind: 'audio',
  },
  mp4: {
    label: 'MP4 Video',
    short: 'MP4',
    description: 'Remux tanpa re-encode bila H.264/HEVC, selain itu H.264 veryfast',
    kind: 'video',
  },
};

export const DEFAULT_FORMAT: OutputFormat = 'mp3-192';

export type JobStatus =
  | 'queued'
  | 'fetching'
  | 'extracting'
  | 'converting'
  | 'ready'
  | 'error'
  | 'cancelled'
  | 'expired';

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'fetching', 'extracting', 'converting'];

export function isActiveStatus(status: JobStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export interface JobView {
  id: string;
  status: JobStatus;
  format: OutputFormat;
  sourceType: 'url' | 'upload';
  sourceLabel: string;
  title: string | null;
  /** Progress of the current stage, 0-100, or null when unknown. */
  progress: number | null;
  queuePosition: number | null;
  fastPath: boolean;
  outputName: string | null;
  outputSize: number | null;
  mediaDurationSec: number | null;
  trim: { startSec: number | null; endSec: number | null };
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  expiresAt: number | null;
  error: string | null;
}

export interface ClientLimits {
  maxUploadMb: number;
  maxDurationMinutes: number;
  fileTtlMinutes: number;
  maxConcurrentJobs: number;
  urlSourceEnabled: boolean;
  authEnabled: boolean;
  allowedUploadExtensions: string[];
}

export const ALLOWED_UPLOAD_EXTENSIONS = [
  'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aif', 'aiff', 'amr', 'ac3', 'mka',
  'mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', '3gp', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg',
];

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === 'string' && (OUTPUT_FORMATS as readonly string[]).includes(value);
}
