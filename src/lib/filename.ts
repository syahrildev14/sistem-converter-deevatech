// Title / filename cleanup ("auto-metadata dasar").

const NOISE_TAGS =
  /\s*[([【]\s*(?:official\s*)?(?:music\s*|lyrics?\s*|hd\s*|hq\s*|4k\s*|full\s*)?(?:video|audio|lyrics?|lyric\s*video|visuali[sz]er|mv|m\/v|hd|hq|4k|1080p|720p|clip|version)\s*[)\]】]/gi;

/** Cleans a media title: removes common noise tags like "(Official Video)", trims separators. */
export function cleanTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  let t = raw.normalize('NFKC');
  // Drop control chars.
  t = t.replace(/[\u0000-\u001f\u007f]/g, ' ');
  t = t.replace(NOISE_TAGS, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^[\s\-_|.,]+|[\s\-_|,]+$/g, '').trim();
  return Array.from(t).slice(0, 150).join('');
}

/** Turns a title into a filesystem- and header-safe file base name (no extension). */
export function safeFileBase(title: string | null | undefined): string {
  let t = cleanTitle(title);
  t = t.replace(/[\\/:*?"<>|]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/^\.+/, '').replace(/[.\s]+$/, '');
  t = Array.from(t).slice(0, 120).join('').trim();
  // Avoid reserved Windows device names.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(t)) t = `${t}_`;
  return t || 'media';
}

/** Strips the extension from an uploaded file's original name. */
export function stripExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(0, idx) : base;
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1).toLowerCase() : '';
}

/** Builds a Content-Disposition header value with an ASCII fallback + RFC 5987 UTF-8 name. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'download';
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
