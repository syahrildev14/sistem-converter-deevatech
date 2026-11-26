import dns from 'node:dns/promises';
import net from 'node:net';
import { getConfig } from './config';
import { UserError } from './errors';

const blocked = new net.BlockList();
for (const cidr of [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
]) {
  const [addr, prefix] = cidr.split('/');
  blocked.addSubnet(addr, Number(prefix), 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

function isBlockedIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) return blocked.check(mapped[1], 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true;
}

/**
 * Validates a user supplied source URL. Only public http(s) URLs are accepted; hosts that resolve to
 * private/loopback/link-local ranges are rejected (basic SSRF protection) unless ALLOW_PRIVATE_URLS=true.
 */
export async function validateSourceUrl(raw: unknown): Promise<string> {
  const cfg = getConfig();
  if (!cfg.urlSourceEnabled) throw new UserError('Sumber URL dinonaktifkan oleh admin. Gunakan upload file.', 403);
  if (typeof raw !== 'string' || raw.trim() === '') throw new UserError('URL sumber wajib diisi.');
  const value = raw.trim();
  if (value.length > 2048) throw new UserError('URL terlalu panjang (maks. 2048 karakter).');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError('Format URL tidak valid. Contoh: https://www.example.com/video/123');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError('Hanya URL http:// atau https:// yang diizinkan.');
  }
  if (url.username || url.password) throw new UserError('URL tidak boleh berisi username/password.');

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new UserError('URL tidak memiliki host.');

  if (cfg.allowedUrlHosts.length > 0) {
    const ok = cfg.allowedUrlHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new UserError(`Domain "${host}" tidak ada dalam daftar yang diizinkan admin.`, 403);
  }

  if (!cfg.allowPrivateUrls) {
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      (net.isIP(host) === 0 && !host.includes('.'))
    ) {
      throw new UserError('URL ke host lokal/internal tidak diizinkan.', 403);
    }
    let addresses: string[];
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
      } catch {
        throw new UserError(`Domain "${host}" tidak dapat ditemukan (DNS gagal). Periksa kembali URL.`);
      }
    }
    if (addresses.length === 0 || addresses.some(isBlockedIp)) {
      throw new UserError('URL mengarah ke alamat jaringan privat/internal dan diblokir.', 403);
    }
  }

  return url.toString();
}
