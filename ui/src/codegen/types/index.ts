// Database type → language type resolution over the per-dialect tables in this folder.
import type { ColumnKind, Dialect } from '../../api/types';
import plsql from './plsql.json';
import sqlite from './sqlite.json';
import tsql from './tsql.json';

export type Logical =
  | 'bool' | 'uint8' | 'int16' | 'int32' | 'int64' | 'decimal' | 'float32' | 'float64' | 'string' | 'date' | 'datetime'
  | 'datetimeoffset' | 'time' | 'interval' | 'guid' | 'binary' | 'rowversion' | 'xml' | 'json' | 'object' | 'cursor';

export interface TypeRow {
  logical: Logical;
  cs: string;
  go: string;
  ts: string;
  java: string;
  py: string;
}

type Table = Record<string, TypeRow>;

function table(json: Record<string, unknown>): Table {
  const out: Table = {};
  for (const [k, v] of Object.entries(json)) if (!k.startsWith('$')) out[k] = v as TypeRow;
  return out;
}

export const TYPE_TABLES: Record<Dialect, Table> = { tsql: table(tsql), plsql: table(plsql), sqlite: table(sqlite) };

export interface ResolvedType extends TypeRow {
  /** Normalized base type used for the lookup (`nvarchar`, `number#decimal`). */
  base: string;
  /** Mapping table hit (false = fell back to the wire kind or `object`). */
  known: boolean;
  /** Character/binary length, null for `max` or not applicable. */
  length: number | null;
  precision: number | null;
  scale: number | null;
  /** Original database type text. */
  dbType: string;
}

export interface TypeOptions {
  /** Oracle NUMBER(1) → bool. */
  numberOneAsBool?: boolean;
}

const UNKNOWN: TypeRow = { logical: 'object', cs: 'object', go: 'any', ts: 'unknown', java: 'Object', py: 'Any' };

const KIND_FALLBACK: Record<ColumnKind, Logical> = {
  int: 'int32', float: 'float64', decimal: 'decimal', string: 'string', bool: 'bool', date: 'date', time: 'time', datetime: 'datetime',
  datetimeoffset: 'datetimeoffset', guid: 'guid', binary: 'binary', json: 'json', xml: 'xml', cursor: 'cursor', other: 'object',
};

/** Language defaults per logical type, used for wire-kind fallbacks. */
export const LOGICAL_DEFAULTS: Record<Logical, TypeRow> = {
  bool: { logical: 'bool', cs: 'bool', go: 'bool', ts: 'boolean', java: 'boolean', py: 'bool' },
  uint8: { logical: 'uint8', cs: 'byte', go: 'uint8', ts: 'number', java: 'short', py: 'int' },
  int16: { logical: 'int16', cs: 'short', go: 'int16', ts: 'number', java: 'short', py: 'int' },
  int32: { logical: 'int32', cs: 'int', go: 'int32', ts: 'number', java: 'int', py: 'int' },
  int64: { logical: 'int64', cs: 'long', go: 'int64', ts: 'number', java: 'long', py: 'int' },
  decimal: { logical: 'decimal', cs: 'decimal', go: 'float64', ts: 'number', java: 'BigDecimal', py: 'Decimal' },
  float32: { logical: 'float32', cs: 'float', go: 'float32', ts: 'number', java: 'float', py: 'float' },
  float64: { logical: 'float64', cs: 'double', go: 'float64', ts: 'number', java: 'double', py: 'float' },
  string: { logical: 'string', cs: 'string', go: 'string', ts: 'string', java: 'String', py: 'str' },
  date: { logical: 'date', cs: 'DateOnly', go: 'time.Time', ts: 'string', java: 'LocalDate', py: 'date' },
  datetime: { logical: 'datetime', cs: 'DateTime', go: 'time.Time', ts: 'string', java: 'LocalDateTime', py: 'datetime' },
  datetimeoffset: { logical: 'datetimeoffset', cs: 'DateTimeOffset', go: 'time.Time', ts: 'string', java: 'OffsetDateTime', py: 'datetime' },
  time: { logical: 'time', cs: 'TimeOnly', go: 'time.Time', ts: 'string', java: 'LocalTime', py: 'time' },
  interval: { logical: 'interval', cs: 'TimeSpan', go: 'time.Duration', ts: 'string', java: 'Duration', py: 'timedelta' },
  guid: { logical: 'guid', cs: 'Guid', go: 'string', ts: 'string', java: 'UUID', py: 'UUID' },
  binary: { logical: 'binary', cs: 'byte[]', go: '[]byte', ts: 'Buffer', java: 'byte[]', py: 'bytes' },
  rowversion: { logical: 'rowversion', cs: 'byte[]', go: '[]byte', ts: 'Buffer', java: 'byte[]', py: 'bytes' },
  xml: { logical: 'xml', cs: 'string', go: 'string', ts: 'string', java: 'String', py: 'str' },
  json: { logical: 'json', cs: 'string', go: 'string', ts: 'unknown', java: 'String', py: 'Any' },
  object: UNKNOWN,
  cursor: { logical: 'cursor', cs: 'object', go: 'any', ts: 'unknown', java: 'Object', py: 'Any' },
};

interface Parsed {
  base: string;
  args: string[];
}

/** `nvarchar(100)` → { base: 'nvarchar', args: ['100'] }; `TIMESTAMP(6) WITH TIME ZONE` → 'timestamp with time zone'. */
export function parseTypeText(typeText: string): Parsed {
  const t = typeText.trim().toLowerCase();
  const args: string[] = [];
  const base = t
    .replace(/\(([^)]*)\)/g, (_, inner: string) => {
      if (!args.length) args.push(...inner.split(',').map((s) => s.trim().replace(/\s+(byte|char)$/, '')));
      return '';
    })
    .replace(/\s+/g, ' ')
    .replace(/\s+(identity|not null|null|unsigned)\b.*$/, '')
    .trim();
  return { base, args };
}

function num(s: string | undefined): number | null {
  if (s === undefined || s === '' || s === '*') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function sqliteAffinity(base: string): string {
  if (base.includes('int')) return 'integer';
  if (/char|clob|text/.test(base)) return 'text';
  if (base === '' || base.includes('blob')) return 'blob';
  if (/real|floa|doub/.test(base)) return 'real';
  return 'numeric';
}

/** Resolve a database type text to language types. */
export function resolveType(dialect: Dialect, typeText: string, opts: TypeOptions & { kind?: ColumnKind } = {}): ResolvedType {
  const { base: rawBase, args } = parseTypeText(typeText);
  const tbl = TYPE_TABLES[dialect];
  let base = rawBase;
  let length: number | null = null;
  let precision: number | null = null;
  let scale: number | null = null;

  if (args.length) {
    if (/char|binary|raw|text|string/.test(rawBase)) length = args[0] === 'max' ? null : num(args[0]);
    else {
      precision = num(args[0]);
      scale = args.length > 1 ? num(args[1]) : rawBase === 'number' || rawBase === 'decimal' || rawBase === 'numeric' ? 0 : null;
    }
  }

  if (dialect === 'plsql' && (rawBase === 'number' || rawBase === 'numeric' || rawBase === 'decimal')) {
    if (precision === null) base = 'number#decimal';
    else if ((scale ?? 0) > 0) base = 'number#decimal';
    else if (precision === 1 && opts.numberOneAsBool) base = 'number#bool';
    else if (precision <= 9) base = 'number#int';
    else if (precision <= 18) base = 'number#long';
    else base = 'number#bigint';
  }
  // T-SQL float(n): n <= 24 is a real.
  if (dialect === 'tsql' && rawBase === 'float' && precision !== null && precision <= 24) base = 'real';
  if (dialect === 'tsql' && (rawBase === 'decimal' || rawBase === 'numeric') && precision === null) {
    precision = 18;
    scale = 0;
  }

  let row = tbl[base];
  let known = !!row;
  if (!row && dialect === 'sqlite') {
    row = tbl[sqliteAffinity(rawBase)];
    known = true;
  }
  if (!row && opts.kind) {
    row = LOGICAL_DEFAULTS[KIND_FALLBACK[opts.kind]];
    known = opts.kind !== 'other';
  }
  if (!row) row = UNKNOWN;
  return { ...row, base, known, length, precision, scale, dbType: typeText };
}
