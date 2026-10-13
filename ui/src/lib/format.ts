import type { CellValue, ColumnInfo, ColumnKind } from '../api/types';

export function isBinary(v: CellValue): v is { $bin: string; len: number } {
  return typeof v === 'object' && v !== null && '$bin' in v;
}
export function isTruncated(v: CellValue): v is { $trunc: string; len: number } {
  return typeof v === 'object' && v !== null && '$trunc' in v;
}
export function isCursor(v: CellValue): v is { $cursor: true } {
  return typeof v === 'object' && v !== null && '$cursor' in v;
}
/** True when the grid only has part of the value and the full one must come from GET .../cell. */
export function isPartial(v: CellValue): boolean {
  return isBinary(v) ? base64Length(v.$bin) < v.len : isTruncated(v);
}

export function base64Length(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export function base64ToHex(b64: string, maxBytes = Infinity): string {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return '';
  }
  const n = Math.min(bin.length, maxBytes);
  let out = '';
  for (let i = 0; i < n; i++) out += bin.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase();
  return out;
}

export function isNumericKind(k: ColumnKind): boolean {
  return k === 'int' || k === 'float' || k === 'decimal';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface FormatOptions {
  nullText: string;
  dateFormat: 'iso' | 'locale';
}

function formatDateLike(s: string, kind: ColumnKind, opts: FormatOptions): string {
  if (opts.dateFormat === 'locale') {
    const d = new Date(kind === 'time' ? `1970-01-01T${s}` : s);
    if (!Number.isNaN(d.getTime())) {
      if (kind === 'date') return d.toLocaleDateString();
      if (kind === 'time') return d.toLocaleTimeString();
      return d.toLocaleString();
    }
  }
  // ISO without the 'T' and with trailing fractional zeros trimmed: 2026-10-14 10:00:00.123
  let out = s.replace('T', ' ');
  out = out.replace(/(\.\d*?)0+(?=$|[+Z-])/, '$1').replace(/\.(?=$|[+Z-])/, '');
  return out;
}

/** Display text for one cell in the grid (single line). */
export function formatCell(v: CellValue, col: ColumnInfo | undefined, opts: FormatOptions): string {
  if (v === null || v === undefined) return opts.nullText;
  const kind = col?.kind ?? 'other';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (kind === 'bool') return v ? 'true' : 'false';
    return String(v);
  }
  if (typeof v === 'string') {
    if (kind === 'date' || kind === 'datetime' || kind === 'datetimeoffset' || kind === 'time') {
      return formatDateLike(v, kind, opts);
    }
    return oneLine(v);
  }
  if (isBinary(v)) {
    const hex = base64ToHex(v.$bin, 24);
    return `0x${hex}${v.len > 24 ? '…' : ''}  (${formatBytes(v.len)})`;
  }
  if (isTruncated(v)) return `${oneLine(v.$trunc.slice(0, 2000))}… (${formatBytes(v.len)})`;
  if (isCursor(v)) return '<cursor>';
  return String(v);
}

function oneLine(s: string): string {
  if (s.length > 2000) s = s.slice(0, 2000) + '…';
  return s.includes('\n') || s.includes('\r') ? s.replace(/\r?\n/g, ' ↵ ') : s;
}

/** Raw text of a value (clipboard, cell viewer). */
export function rawText(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isBinary(v)) return `0x${base64ToHex(v.$bin)}`;
  if (isTruncated(v)) return v.$trunc;
  if (isCursor(v)) return '<cursor>';
  return String(v);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Pretty print JSON or XML text for the value viewer; returns the input unchanged when it is neither. */
export function prettyPrint(text: string, kind: ColumnKind): { text: string; language: 'json' | 'xml' | 'text' } {
  const t = text.trim();
  if (kind === 'json' || ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) {
    try {
      return { text: JSON.stringify(JSON.parse(t), null, 2), language: 'json' };
    } catch {
      /* not JSON */
    }
  }
  if (kind === 'xml' || (t.startsWith('<') && t.endsWith('>'))) {
    return { text: prettyXml(t), language: 'xml' };
  }
  return { text, language: 'text' };
}

export function prettyXml(xml: string): string {
  const tokens = xml.replace(/>\s+</g, '><').split(/(<[^>]+>)/).filter((s) => s.length > 0);
  let depth = 0;
  const lines: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.startsWith('</')) {
      depth = Math.max(0, depth - 1);
      lines.push('  '.repeat(depth) + tok);
    } else if (tok.startsWith('<?') || tok.startsWith('<!') || tok.endsWith('/>')) {
      lines.push('  '.repeat(depth) + tok);
    } else if (tok.startsWith('<')) {
      // <a>text</a> on one line
      if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('<') && tokens[i + 2]?.startsWith('</')) {
        lines.push('  '.repeat(depth) + tok + tokens[i + 1] + tokens[i + 2]);
        i += 3;
        continue;
      }
      lines.push('  '.repeat(depth) + tok);
      depth++;
    } else {
      lines.push('  '.repeat(depth) + tok.trim());
    }
    i++;
  }
  return lines.join('\n');
}
