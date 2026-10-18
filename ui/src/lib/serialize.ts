import type { CellValue, ColumnInfo, Dialect } from '../api/types';
import { base64ToHex, isBinary, isCursor, isNumericKind, isPartial, isTruncated, rawText } from './format';
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

/** A decimal / big-int string that a JSON number represents exactly ("1.5", "-0.1"; not "12.50" or 2^60). */
const losslessNumber = (v: string) => /^-?\d+(\.\d+)?$/.test(v) && String(Number(v)) === v;

/**
 * How a numeric column is written to JSON, decided per column so one column never mixes types (logic-24 e):
 * numbers when every non-null value is a JSON number or converts to one losslessly, else strings for every value.
 */
function numericColumnMode(rows: CellValue[][], col: number): 'number' | 'string' {
  for (const r of rows) {
    const v = jsonValue(r[col]);
    if (v === null || v === undefined) continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'string';
      continue;
    }
    if (typeof v !== 'string' || !losslessNumber(v)) return 'string';
  }
  return 'number';
}

export function toJson(columns: ColumnInfo[], rows: CellValue[][]): string {
  const names = uniqueNames(columns);
  // Decimals and big ints travel as strings: JSON numbers only when the whole column converts without loss.
  const modes = columns.map((c, i) => (isNumericKind(c.kind) ? numericColumnMode(rows, i) : null));
  const arr = rows.map((r) => {
    const o: Record<string, unknown> = {};
    names.forEach((n, i) => {
      let v = jsonValue(r[i]);
      if (v !== null && v !== undefined && (typeof v === 'string' || typeof v === 'number')) {
        if (modes[i] === 'number' && typeof v === 'string') v = Number(v);
        else if (modes[i] === 'string' && typeof v === 'number') v = String(v);
      }
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

// ---------------------------------------------------------------- truncated values (logic-12)
//
// Wire values are capped (strings over 32 KB arrive as {$trunc, len}, binaries over 8 KB as a {$bin, len} prefix).
// Serializing them as-is silently writes wrong data, so copy/export first fetches the full values from the
// engine's result store (GET /executions/{xid}/resultsets/{rs}/cell) and refuses SQL INSERT when it cannot.

/** Where a grid cell lives in the engine's result store. */
export interface CellLocator {
  executionId: string;
  resultSetId: number;
  row: number;
  col: number;
}

export type CellFetcher = (loc: CellLocator) => Promise<{ kind: 'string' | 'binary'; value: string; len: number }>;

/** Positions (row index, column index) of values the grid only has a prefix of. */
export function partialCells(rows: readonly (readonly CellValue[])[]): { row: number; col: number }[] {
  const out: { row: number; col: number }[] = [];
  rows.forEach((r, ri) => r.forEach((v, ci) => {
    if (isPartial(v)) out.push({ row: ri, col: ci });
  }));
  return out;
}

export function truncationWarning(n: number): string {
  return `${n} value${n === 1 ? ' is' : 's are'} truncated; use Export instead`;
}

export interface ResolveOptions {
  /** Maps a (row index, column index) of the block to the engine cell; null when the row is not from the store. */
  locate?: ((row: number, col: number) => CellLocator | null) | null;
  fetch?: CellFetcher | null;
  /** At most this many cells are fetched (the rest stay truncated). */
  maxFetch?: number;
}

/** Replaces partial values with the full ones where possible; returns the rows (copied only where changed). */
export async function resolvePartialValues(
  rows: readonly CellValue[][], opts: ResolveOptions,
): Promise<{ rows: CellValue[][]; unresolved: number }> {
  const cells = partialCells(rows);
  if (cells.length === 0) return { rows: rows as CellValue[][], unresolved: 0 };
  const out = rows.slice();
  const copied = new Set<number>();
  let unresolved = 0;
  const { locate, fetch } = opts;
  const max = opts.maxFetch ?? 500;
  const jobs = cells.map((c, i) => ({ ...c, loc: locate && fetch && i < max ? locate(c.row, c.col) : null }));
  unresolved += jobs.filter((j) => !j.loc).length;
  const todo = jobs.filter((j) => j.loc);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const j = todo[next++];
      try {
        const full = await fetch!(j.loc!);
        const v: CellValue = full.kind === 'binary' ? { $bin: full.value, len: full.len } : full.value;
        if (isPartial(v)) {
          unresolved++;
          continue;
        }
        if (!copied.has(j.row)) {
          out[j.row] = out[j.row].slice();
          copied.add(j.row);
        }
        out[j.row][j.col] = v;
      } catch {
        unresolved++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  return { rows: out, unresolved };
}

export type SerializeOutcome = { ok: true; text: string; warning: string | null } | { ok: false; message: string };

/**
 * Serialize for the clipboard / client-side export with full values. SQL INSERT is refused while values are still
 * truncated (it would insert wrong data); the other formats are produced with a warning.
 */
export async function serializeComplete(
  format: CopyFormat, columns: ColumnInfo[], rows: CellValue[][], opts: SerializeOptions & ResolveOptions = {},
): Promise<SerializeOutcome> {
  const r = await resolvePartialValues(rows, opts);
  if (r.unresolved > 0 && format === 'sql-insert') return { ok: false, message: truncationWarning(r.unresolved) };
  return { ok: true, text: serializeRows(format, columns, r.rows, opts), warning: r.unresolved > 0 ? truncationWarning(r.unresolved) : null };
}
