import type { CellValue, ColumnInfo, Dialect } from '../api/types';
import { base64ToHex, isBinary, isCursor, isNumericKind, isTruncated, rawText } from './format';
import { quoteIdent } from './sql';

/** Copy / client-side export formats for a block of rows (DataGrip "Copy as"). */
export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'sql-insert';

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: 'TSV (tab-separated)',
  csv: 'CSV',
  json: 'JSON',
  markdown: 'Markdown table',
  'sql-insert': 'SQL INSERT statements',
};

export interface SerializeOptions {
  header?: boolean;
  nullText?: string;
  tableName?: string;
  dialect?: Dialect;
}

function csvField(s: string, delim: string): string {
  if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function tsvField(s: string): string {
  return s.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}

export function toDelimited(columns: ColumnInfo[], rows: CellValue[][], delim: string, opts: SerializeOptions = {}): string {
  const header = opts.header ?? true;
  const nullText = opts.nullText ?? '';
  const esc = delim === '\t' ? tsvField : (s: string) => csvField(s, delim);
  const lines: string[] = [];
  if (header) lines.push(columns.map((c) => esc(c.name)).join(delim));
  for (const r of rows) lines.push(r.map((v) => esc(rawText(v) ?? nullText)).join(delim));
  return lines.join(delim === '\t' ? '\n' : '\r\n');
}

function jsonValue(v: CellValue): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (isBinary(v)) return `0x${base64ToHex(v.$bin)}`;
  if (isTruncated(v)) return v.$trunc;
  if (isCursor(v)) return null;
  return v;
}

export function toJson(columns: ColumnInfo[], rows: CellValue[][]): string {
  const names = uniqueNames(columns);
  const arr = rows.map((r) => {
    const o: Record<string, unknown> = {};
    names.forEach((n, i) => {
      let v = jsonValue(r[i]);
      // Decimals and big ints travel as strings; keep them exact but as JSON numbers when lossless.
      if (typeof v === 'string' && isNumericKind(columns[i].kind) && /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v) v = Number(v);
      o[n] = v;
    });
    return o;
  });
  return JSON.stringify(arr, null, 2);
}

function uniqueNames(columns: ColumnInfo[]): string[] {
  const seen = new Map<string, number>();
  return columns.map((c) => {
    const base = c.name || `column${c.ordinal + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}_${n + 1}`;
  });
}

export function toMarkdown(columns: ColumnInfo[], rows: CellValue[][], opts: SerializeOptions = {}): string {
  const nullText = opts.nullText ?? 'NULL';
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
  const head = `| ${columns.map((c) => esc(c.name)).join(' | ')} |`;
  const sep = `| ${columns.map((c) => (isNumericKind(c.kind) ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((v) => esc(rawText(v) ?? nullText)).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

export function sqlLiteral(v: CellValue, col: ColumnInfo, dialect: Dialect): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0'; // bit / NUMBER(1) / INTEGER in all three dialects
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (isBinary(v)) {
    const hex = base64ToHex(v.$bin);
    if (dialect === 'tsql') return `0x${hex}`;
    if (dialect === 'plsql') return `HEXTORAW('${hex}')`;
    return `X'${hex}'`;
  }
  if (isCursor(v)) return 'NULL';
  const s = isTruncated(v) ? v.$trunc : v;
  if (isNumericKind(col.kind) && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return s;
  const quoted = `'${s.replace(/'/g, "''")}'`;
  if (dialect === 'plsql' && (col.kind === 'datetime' || col.kind === 'date')) {
    return `TIMESTAMP '${s.replace('T', ' ')}'`;
  }
  if (dialect === 'tsql' && /[^\x00-\x7f]/.test(s)) return `N${quoted}`;
  return quoted;
}

export function defaultTableName(columns: ColumnInfo[], dialect: Dialect): string {
  const c = columns.find((x) => x.table);
  if (!c?.table) return 'result';
  return c.schema ? `${quoteIdent(c.schema, dialect)}.${quoteIdent(c.table, dialect)}` : quoteIdent(c.table, dialect);
}

export function toSqlInsert(columns: ColumnInfo[], rows: CellValue[][], opts: SerializeOptions = {}): string {
  const dialect = opts.dialect ?? 'sqlite';
  const table = opts.tableName ?? defaultTableName(columns, dialect);
  const cols = columns.map((c) => quoteIdent(c.name, dialect)).join(', ');
  return rows
    .map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => sqlLiteral(v, columns[i], dialect)).join(', ')});`)
    .join('\n');
}

export function serializeRows(format: CopyFormat, columns: ColumnInfo[], rows: CellValue[][], opts: SerializeOptions = {}): string {
  switch (format) {
    case 'tsv':
      return toDelimited(columns, rows, '\t', opts);
    case 'csv':
      return toDelimited(columns, rows, ',', opts);
    case 'json':
      return toJson(columns, rows);
    case 'markdown':
      return toMarkdown(columns, rows, opts);
    case 'sql-insert':
      return toSqlInsert(columns, rows, opts);
  }
}
