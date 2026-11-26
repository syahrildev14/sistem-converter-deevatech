import { spawn } from 'node:child_process';
import { UserError } from './errors';

export interface RunOptions {
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  /** Number of trailing stderr/stdout lines to keep for error reporting. */
  tailLines?: number;
}

export interface RunResult {
  code: number | null;
  aborted: boolean;
  /** Last lines from stderr (and stdout lines that look like errors). */
  tail: string[];
}

function lineSplitter(onLine: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: Buffer) {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.search(/\r?\n|\r/)) >= 0) {
        const line = buffer.slice(0, idx);
        const sepLen = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(idx + sepLen);
        if (line.length) onLine(line);
      }
      // Guard against pathological output without newlines.
      if (buffer.length > 64 * 1024) {
        onLine(buffer);
        buffer = '';
      }
    },
    flush() {
      if (buffer.length) onLine(buffer);
      buffer = '';
    },
  };
}

/**
 * Runs an external binary WITHOUT a shell. Arguments are passed as an array, so user input can never
 * be interpreted as shell syntax (no command injection).
 */
export function runProcess(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const tailMax = opts.tailLines ?? 40;
  const tail: string[] = [];
  const pushTail = (line: string) => {
    tail.push(line);
    if (tail.length > tailMax) tail.shift();
  };

  return new Promise<RunResult>((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, aborted: true, tail });
      return;
    }

    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const out = lineSplitter((line) => {
      if (/error/i.test(line)) pushTail(line);
      opts.onStdoutLine?.(line);
    });
    const err = lineSplitter((line) => {
      pushTail(line);
      opts.onStderrLine?.(line);
    });

    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));

    child.on('error', (e: NodeJS.ErrnoException) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (e.code === 'ENOENT') {
        reject(new UserError(`Program "${command}" tidak ditemukan di server. Hubungi admin (cek instalasi / PATH).`, 500));
      } else {
        reject(e);
      }
    });

    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      out.flush();
      err.flush();
      resolve({ code, aborted, tail });
    });
  });
}
