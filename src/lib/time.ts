// Shared timecode helpers (client + server).

const PART = /^\d{1,6}(?:\.\d{1,3})?$/;

/**
 * Parses "90", "1:30", "01:02:03", "1:30.5" into seconds.
 * Returns null for empty input; throws Error with a readable message on invalid input.
 */
export function parseTimecode(input: unknown, label: string): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`${label} tidak valid.`);
    return input;
  }
  if (typeof input !== 'string') throw new Error(`${label} tidak valid.`);
  const value = input.trim();
  if (value === '') return null;

  const parts = value.split(':');
  if (parts.length > 3 || parts.some((p) => !PART.test(p))) {
    throw new Error(`${label} harus berformat detik (90), mm:ss (1:30) atau hh:mm:ss (01:02:03).`);
  }
  // Only the last segment may carry decimals, minutes/seconds segments must be < 60 when a larger unit exists.
  if (parts.slice(0, -1).some((p) => p.includes('.'))) {
    throw new Error(`${label}: desimal hanya boleh pada bagian detik.`);
  }
  const nums = parts.map(Number);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] >= 60) throw new Error(`${label}: menit/detik harus di bawah 60.`);
  }
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return Math.round(seconds * 1000) / 1000;
}

export function formatDuration(totalSec: number | null | undefined): string {
  if (totalSec === null || totalSec === undefined || !Number.isFinite(totalSec)) return '-';
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
