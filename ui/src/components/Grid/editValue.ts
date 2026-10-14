// Typed text → cell value for in-grid editing, validated per column kind.
import type { CellValue, ColumnInfo, Dialect } from '../../api/types';
import { rawText } from '../../lib/format';
import { normalizeDecimal, parseDateOperand, parseTimeOperand } from '../../filter/values';

export type ParsedEdit = { ok: true; value: CellValue } | { ok: false; error: string };

const GUID = /^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$/i;

export function parseEdit(text: string, col: ColumnInfo, dialect: Dialect): ParsedEdit {
  const t = text;
  const trimmed = t.trim();
  const kind = col.kind;
  if (kind === 'string' || kind === 'json' || kind === 'xml' || kind === 'other') return { ok: true, value: t };
  if (trimmed === '') return col.nullable ? { ok: true, value: null } : { ok: false, error: `${col.name} cannot be NULL` };
  switch (kind) {
    case 'int': {
      if (!/^[+-]?\d+$/.test(trimmed)) return { ok: false, error: 'Enter a whole number' };
      const n = Number(trimmed);
      return { ok: true, value: Number.isSafeInteger(n) ? n : trimmed };
    }
    case 'float': {
      const n = Number(trimmed);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'Enter a number' };
    }
    case 'decimal': {
      if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return { ok: false, error: 'Enter a decimal number' };
      if (col.scale !== null && col.scale >= 0) {
        const frac = trimmed.split('.')[1] ?? '';
        if (frac.replace(/0+$/, '').length > col.scale) return { ok: false, error: `At most ${col.scale} decimals` };
      }
      return { ok: true, value: normalizeDecimal(trimmed) };
    }
    case 'bool': {
      const s = trimmed.toLowerCase();
      if (['1', 'true', 'yes', 'y', 't'].includes(s)) return { ok: true, value: true };
      if (['0', 'false', 'no', 'n', 'f'].includes(s)) return { ok: true, value: false };
      return { ok: false, error: 'Enter true or false' };
    }
    case 'date': case 'datetime': case 'datetimeoffset': {
      if (dialect === 'sqlite') return { ok: true, value: t };
      if (kind === 'datetimeoffset' && /[+-]\d{2}:?\d{2}$|Z$/.test(trimmed)) return { ok: true, value: trimmed.replace(' ', 'T') };
      const d = parseDateOperand(trimmed);
      if (!d) return { ok: false, error: kind === 'date' ? 'Use YYYY-MM-DD' : 'Use YYYY-MM-DD HH:MM[:SS]' };
      return { ok: true, value: kind === 'date' && d.length > 10 && d.endsWith('T00:00:00') ? d.slice(0, 10) : d };
    }
    case 'time': {
      const v = parseTimeOperand(trimmed);
      return v ? { ok: true, value: v } : { ok: false, error: 'Use HH:MM[:SS]' };
    }
    case 'guid':
      return GUID.test(trimmed) ? { ok: true, value: trimmed.replace(/^\{|\}$/g, '') } : { ok: false, error: 'Not a GUID' };
    default:
      return { ok: true, value: t };
  }
}

/** Text shown in the editor overlay for a value. */
export function editText(v: CellValue): string {
  if (v === null || v === undefined) return '';
  return rawText(v) ?? '';
}

export function isEditableKind(col: ColumnInfo): boolean {
  return col.kind !== 'binary' && col.kind !== 'cursor';
}
