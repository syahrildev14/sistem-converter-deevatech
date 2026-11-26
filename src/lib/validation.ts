import { getConfig } from './config';
import { UserError } from './errors';
import { cleanTitle } from './filename';
import { parseTimecode } from './time';
import { isOutputFormat, type OutputFormat } from './types';

export interface JobParams {
  format: OutputFormat;
  startSec: number | null;
  endSec: number | null;
  title: string | null;
}

/** Validates the shared job parameters (format, trim, title) from JSON body or query string. */
export function parseJobParams(input: {
  format?: unknown;
  start?: unknown;
  end?: unknown;
  title?: unknown;
}): JobParams {
  if (!isOutputFormat(input.format)) throw new UserError('Format output tidak dikenal.');

  let startSec: number | null;
  let endSec: number | null;
  try {
    startSec = parseTimecode(input.start, 'Waktu mulai');
    endSec = parseTimecode(input.end, 'Waktu selesai');
  } catch (e) {
    throw new UserError((e as Error).message);
  }
  if (startSec === 0) startSec = null;
  const maxSec = getConfig().maxDurationMinutes * 60;
  if (startSec !== null && startSec > maxSec) throw new UserError('Waktu mulai melebihi batas durasi.');
  if (endSec !== null && startSec !== null && endSec <= startSec) {
    throw new UserError('Waktu selesai harus lebih besar dari waktu mulai.');
  }
  if (endSec !== null && endSec <= 0) throw new UserError('Waktu selesai harus lebih dari 0.');

  let title: string | null = null;
  if (input.title !== undefined && input.title !== null && input.title !== '') {
    if (typeof input.title !== 'string' || input.title.length > 300) throw new UserError('Judul tidak valid (maks. 300 karakter).');
    title = cleanTitle(input.title) || null;
  }

  return { format: input.format, startSec, endSec, title };
}
