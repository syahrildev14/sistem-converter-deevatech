import path from 'node:path';
import type { AppConfig } from './config';
import { UserError } from './errors';
import { runProcess, type RunResult } from './process';
import type { OutputFormat } from './types';

export interface AudioStreamInfo {
  codec: string;
  bitrateKbps: number | null;
  sampleRate: number | null;
  channels: number | null;
}

export interface VideoStreamInfo {
  codec: string;
  width: number | null;
  height: number | null;
}

export interface ProbeInfo {
  durationSec: number | null;
  formatName: string;
  audio: AudioStreamInfo | null;
  video: VideoStreamInfo | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  width?: number;
  height?: number;
  disposition?: { attached_pic?: number };
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

function num(v: string | number | undefined): number | null {
  if (v === undefined) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function probeMedia(cfg: AppConfig, file: string, signal?: AbortSignal): Promise<ProbeInfo> {
  const chunks: string[] = [];
  const res = await runProcess(
    cfg.ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
    { signal, onStdoutLine: (l) => chunks.push(l) },
  );
  if (res.aborted) throw new UserError('Dibatalkan.', 499);
  if (res.code !== 0) {
    throw new UserError('File tidak dikenali sebagai audio/video yang valid atau rusak. Pastikan formatnya didukung.');
  }
  let data: FfprobeOutput;
  try {
    data = JSON.parse(chunks.join('\n')) as FfprobeOutput;
  } catch {
    throw new UserError('Gagal membaca informasi media (ffprobe).');
  }
  const streams = data.streams ?? [];
  const a = streams.find((s) => s.codec_type === 'audio');
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const formatBitrate = num(data.format?.bit_rate);

  return {
    durationSec: num(data.format?.duration),
    formatName: data.format?.format_name ?? '',
    audio: a
      ? {
          codec: a.codec_name ?? 'unknown',
          bitrateKbps: (() => {
            const b = num(a.bit_rate) ?? (v ? null : formatBitrate);
            return b ? Math.round(b / 1000) : null;
          })(),
          sampleRate: num(a.sample_rate),
          channels: a.channels ?? null,
        }
      : null,
    video: v ? { codec: v.codec_name ?? 'unknown', width: v.width ?? null, height: v.height ?? null } : null,
  };
}

export interface PlanOptions {
  format: OutputFormat;
  probe: ProbeInfo;
  input: string;
  outDir: string;
  title: string;
  startSec: number | null;
  endSec: number | null;
  /** When true, never use stream copy (fallback after a failed fast-path attempt). */
  forceTranscode: boolean;
}

export interface ConvertPlan {
  args: string[];
  outputPath: string;
  ext: string;
  fastPath: boolean;
  summary: string;
}

const AUDIO_COPY_CONTAINERS: Record<string, string> = {
  aac: 'm4a',
  alac: 'm4a',
  mp3: 'mp3',
  opus: 'opus',
  vorbis: 'ogg',
  flac: 'flac',
  ac3: 'ac3',
  eac3: 'eac3',
  mp2: 'mp2',
  pcm_s16le: 'wav',
  pcm_s24le: 'wav',
  pcm_s32le: 'wav',
  pcm_f32le: 'wav',
  pcm_u8: 'wav',
};

const MP4_VIDEO_COPY = ['h264', 'hevc', 'mpeg4'];
const MP4_AUDIO_COPY = ['aac', 'mp3', 'ac3', 'eac3', 'alac'];

function ts(sec: number): string {
  return sec.toFixed(3);
}

export function buildPlan(cfg: AppConfig, o: PlanOptions): ConvertPlan {
  const { probe, forceTranscode } = o;
  const audio = probe.audio;

  const pre = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  // Input seeking (-ss before -i) is the fast way to trim.
  if (o.startSec) pre.push('-ss', ts(o.startSec));
  pre.push('-i', o.input);

  const duration: string[] = [];
  if (o.endSec !== null) duration.push('-t', ts(o.endSec - (o.startSec ?? 0)));

  const audioOnlyMap = ['-map', '0:a:0', '-vn', '-sn', '-dn'];
  let map: string[] = audioOnlyMap;
  let codec: string[];
  let ext: string;
  let fastPath = false;
  let summary: string;

  if (o.format !== 'mp4' && !audio) {
    throw new UserError('Sumber tidak memiliki stream audio.');
  }

  switch (o.format) {
    case 'mp3-128':
    case 'mp3-192':
    case 'mp3-320': {
      const kbps = Number(o.format.split('-')[1]);
      ext = 'mp3';
      // Re-encoding an MP3 to an equal/higher bitrate wastes time and gains nothing: copy it.
      const copy =
        !forceTranscode && audio!.codec === 'mp3' && (audio!.bitrateKbps === null || audio!.bitrateKbps <= kbps * 1.05 + 2);
      if (copy) {
        codec = ['-c:a', 'copy'];
        fastPath = true;
        summary = 'Sumber sudah MP3 — stream copy tanpa re-encode';
      } else {
        codec = ['-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-compression_level', String(cfg.mp3AlgorithmQuality)];
        summary = `Transcode MP3 ${kbps} kbps (LAME)`;
      }
      codec.push('-id3v2_version', '3');
      break;
    }
    case 'm4a': {
      ext = 'm4a';
      if (!forceTranscode && audio!.codec === 'aac') {
        codec = ['-c:a', 'copy'];
        fastPath = true;
        summary = 'Sumber sudah AAC — stream copy ke M4A';
      } else {
        codec = ['-c:a', 'aac', '-b:a', '192k'];
        summary = 'Transcode AAC 192 kbps';
      }
      break;
    }
    case 'wav': {
      ext = 'wav';
      if (!forceTranscode && audio!.codec === 'pcm_s16le') {
        codec = ['-c:a', 'copy'];
        fastPath = true;
        summary = 'Sumber sudah PCM 16-bit — stream copy';
      } else {
        codec = ['-c:a', 'pcm_s16le'];
        summary = 'Decode ke PCM 16-bit WAV';
      }
      break;
    }
    case 'audio-copy': {
      ext = forceTranscode ? 'mka' : (AUDIO_COPY_CONTAINERS[audio!.codec] ?? 'mka');
      codec = ['-c:a', 'copy'];
      fastPath = true;
      summary = `Ekstrak audio asli (${audio!.codec}) tanpa re-encode`;
      break;
    }
    case 'mp4': {
      const video = probe.video;
      if (!video) throw new UserError('Sumber tidak memiliki stream video. Pilih format audio (MP3/M4A/WAV).');
      ext = 'mp4';
      map = ['-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn'];
      const tooTall = video.height !== null && video.height > cfg.maxVideoHeight;
      const vCopy = !forceTranscode && !tooTall && MP4_VIDEO_COPY.includes(video.codec);
      const aCopy = !forceTranscode && !!audio && MP4_AUDIO_COPY.includes(audio.codec);
      codec = vCopy
        ? ['-c:v', 'copy', ...(video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
        : [
            '-c:v', 'libx264', '-preset', cfg.videoPreset, '-crf', '23', '-pix_fmt', 'yuv420p',
            ...(tooTall ? ['-vf', `scale=-2:${cfg.maxVideoHeight}`] : []),
          ];
      if (audio) codec.push(...(aCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k']));
      codec.push('-movflags', '+faststart');
      fastPath = vCopy;
      summary = vCopy
        ? `Remux ${video.codec.toUpperCase()} ke MP4 tanpa re-encode video`
        : `Transcode video H.264 (${cfg.videoPreset})`;
      break;
    }
  }

  const metadata = ['-map_metadata', '0', '-metadata', `title=${o.title}`];
  const outputPath = path.join(/*turbopackIgnore: true*/ o.outDir, `output.${ext}`);

  return {
    args: [...pre, ...map, ...codec, ...duration, ...metadata, '-threads', String(cfg.ffmpegThreads), outputPath],
    outputPath,
    ext,
    fastPath,
    summary,
  };
}

export async function runFfmpeg(
  cfg: AppConfig,
  plan: ConvertPlan,
  expectedDurationSec: number | null,
  onProgress: (pct: number) => void,
  signal: AbortSignal,
): Promise<RunResult> {
  let last = -1;
  return runProcess(cfg.ffmpegPath, plan.args, {
    signal,
    onStdoutLine: (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && expectedDurationSec && expectedDurationSec > 0) {
        const pct = Math.min(99, Math.max(0, Math.floor((Number(m[1]) / 1e6 / expectedDurationSec) * 100)));
        if (pct !== last) {
          last = pct;
          onProgress(pct);
        }
      }
    },
  });
}

export function describeFfmpegFailure(tail: string[]): string {
  const text = tail.join('\n');
  if (/Invalid data found when processing input/i.test(text)) {
    return 'File sumber rusak atau formatnya tidak didukung.';
  }
  if (/No space left on device/i.test(text)) return 'Penyimpanan server penuh. Hubungi admin.';
  if (/does not contain any stream|Output file #0 does not contain/i.test(text)) {
    return 'Sumber tidak memiliki stream yang bisa dikonversi ke format ini.';
  }
  const last = tail.filter((l) => l.trim()).slice(-1)[0];
  return `Konversi gagal${last ? `: ${last.slice(0, 300)}` : '.'}`;
}
