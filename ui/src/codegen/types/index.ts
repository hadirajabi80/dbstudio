// Database type → language type resolution over the per-dialect tables in this folder.
import type { ColumnKind, Dialect } from '../../api/types';
import pgsql from './pgsql.json';
import plsql from './plsql.json';
import sqlite from './sqlite.json';
import tsql from './tsql.json';
// Batch 3: one type map per work package (WP0 stubs)
import mysql from './mysql.json';
import clickhouse from './clickhouse.json';
import snowflake from './snowflake.json';
import cql from './cql.json';

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

export const TYPE_TABLES: Record<Dialect, Table> = {
  tsql: table(tsql), plsql: table(plsql), sqlite: table(sqlite), pgsql: table(pgsql),
  mysql: table(mysql), clickhouse: table(clickhouse), snowflake: table(snowflake), cql: table(cql),
};

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
  /** PostgreSQL array (`text[]`, `integer[][]`): the language types are the element's wrapped in the language's list type. */
  array?: boolean;
  /** Element type of an array. */
  element?: ResolvedType;
  /** Labels of a user enum type (from the catalog), in declaration order. */
  enumLabels?: string[];
}

export interface TypeOptions {
  /** Oracle NUMBER(1) → bool. */
  numberOneAsBool?: boolean;
  /** PostgreSQL: labels of the column's enum type (catalog `type` object), when it is one. */
  enumLabels?: string[] | null;
  /** PostgreSQL: base type text of the column's domain type, when it is one. */
  domainBase?: string | null;
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

/** Wrap an element type in each language's list type (PostgreSQL arrays). */
/** Java element types of arrays are boxed: pgjdbc's `Array.getArray()` returns `Integer[]`, never `int[]`. */
const JAVA_BOXED: Record<string, string> = {
  boolean: 'Boolean', byte: 'Byte', short: 'Short', int: 'Integer', long: 'Long', float: 'Float', double: 'Double', char: 'Character',
};

function arrayRow(e: TypeRow): TypeRow {
  const java = JAVA_BOXED[e.java] ?? e.java;
  return { logical: 'object', cs: `${e.cs}[]`, go: `[]${e.go}`, ts: /^[A-Za-z_.]+$/.test(e.ts) ? `${e.ts}[]` : `(${e.ts})[]`, java: `${java}[]`, py: `list[${e.py}]` };
}

/** PostgreSQL spellings normalised to the table keys: `timestamp(3) with time zone`, `character varying(20)`, `_int4`. */
function pgBase(base: string): string {
  const b = base.replace(/^pg_catalog\./, '').replace(/^"(.*)"$/, '$1');
  if (b === 'character varying') return 'varchar';
  if (b === 'bit varying') return 'varbit';
  return b;
}

/** Resolve a database type text to language types. */
export function resolveType(dialect: Dialect, typeText: string, opts: TypeOptions & { kind?: ColumnKind } = {}): ResolvedType {
  if (dialect === 'pgsql') {
    const t = typeText.trim();
    // `integer[]`, `varchar(20)[]`, `text ARRAY`; the catalog's internal `_int4` spelling too.
    const arr = /^(.*?)(\s*\[\s*\d*\s*\])+$/.exec(t) ?? /^(.*?)\s+array$/i.exec(t) ?? (/^_[a-z]/i.test(t) && TYPE_TABLES.pgsql[t.slice(1)] ? [t, t.slice(1)] : null);
    if (arr) {
      const element = resolveType(dialect, arr[1], { ...opts, kind: undefined });
      return { ...arrayRow(element), base: `${element.base}[]`, known: element.known, length: null, precision: null, scale: null, dbType: typeText, array: true, element };
    }
  }
  const { base: rawBase0, args } = parseTypeText(typeText);
  const rawBase = dialect === 'pgsql' ? pgBase(rawBase0) : rawBase0;
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
  // PostgreSQL domain / user enum (unknown base, info from the catalog): before the wire-kind fallback, which would
  // turn a query's enum column into a plain string and drop its labels.
  if (!row && dialect === 'pgsql' && opts.domainBase) {
    const b = resolveType(dialect, opts.domainBase, { ...opts, domainBase: null });
    return { ...b, dbType: typeText };
  }
  if (!row && dialect === 'pgsql' && opts.enumLabels?.length) {
    return { ...LOGICAL_DEFAULTS.string, base, known: true, length: null, precision: null, scale: null, dbType: typeText, enumLabels: [...opts.enumLabels] };
  }
  if (!row && opts.kind) {
    row = LOGICAL_DEFAULTS[KIND_FALLBACK[opts.kind]];
    known = opts.kind !== 'other';
  }
  if (!row) row = UNKNOWN;
  return { ...row, base, known, length, precision, scale, dbType: typeText };
}
