// "Edit" (F4) rewrite of stored DDL into a re-runnable script (docs/PLAN-M1.5.md 1.3.3):
//   T-SQL  CREATE PROCEDURE/FUNCTION/VIEW/TRIGGER → CREATE OR ALTER (ALTER on servers older than 2016 SP1)
//   Oracle CREATE [EDITIONABLE] PROCEDURE/FUNCTION/PACKAGE [BODY]/TRIGGER/VIEW/TYPE → CREATE OR REPLACE, `/` after blocks
//   SQLite views/triggers → DROP … IF EXISTS; prepended (SQLite has no CREATE OR REPLACE)
//   PostgreSQL FUNCTION/PROCEDURE/VIEW/TRIGGER → CREATE OR REPLACE (triggers before 14: DROP TRIGGER IF EXISTS), mviews DROP first
// Pure: no React, Monaco or DOM.
import type { CatalogObjectType, Dialect } from '../api/types';
import { getSpec } from '../intel/dialect';
import { tokenize } from '../intel/lexer/lexer';
import type { Token } from '../intel/types';

export interface RewriteOptions {
  dialect: Dialect;
  type: CatalogObjectType;
  /** Object name as stored (used for SQLite DROP … IF EXISTS). */
  name: string;
  schema?: string | null;
  /** SQL Server `productVersion` ("16.0.1000.6"); CREATE OR ALTER needs 13.0.4001 (2016 SP1) or later. */
  productVersion?: string | null;
}

export interface RewriteResult {
  text: string;
  /** False when the DDL already had the re-runnable form or no CREATE header was found. */
  changed: boolean;
  /** Human-readable summary for the tab ("CREATE → CREATE OR ALTER"). */
  note: string | null;
}

const TSQL_KINDS = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'VIEW', 'TRIGGER']);
const ORACLE_KINDS = new Set(['PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'VIEW', 'TYPE', 'LIBRARY', 'JAVA']);

const significant = (t: Token) => t.kind !== 'ws' && t.kind !== 'comment' && t.kind !== 'eof';

/** True when the server supports CREATE OR ALTER (SQL Server 2016 SP1 = 13.0.4001 or later; unknown = assume yes). */
export function supportsCreateOrAlter(productVersion: string | null | undefined): boolean {
  if (!productVersion) return true;
  const [maj, , build] = productVersion.split('.').map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(maj)) return true;
  if (maj > 13) return true;
  if (maj < 13) return false;
  return (build ?? 0) >= 4001;
}

/** Offsets of every CREATE that starts a statement (first significant token, or after `;`, `GO` or `/`). */
function createHeaders(text: string, dialect: Dialect): { tok: number; toks: Token[] }[] {
  const toks = tokenize(text, getSpec(dialect));
  const sig = toks.filter(significant);
  const out: { tok: number; toks: Token[] }[] = [];
  let depth = 0;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.text === '(') depth++;
    else if (t.text === ')') depth = Math.max(0, depth - 1);
    if (t.upper !== 'CREATE' || depth > 0) continue;
    const prev = sig[i - 1];
    const atStart = !prev || prev.text === ';' || prev.kind === 'batchSep' || prev.text === '/' || prev.upper === 'GO';
    if (atStart) out.push({ tok: i, toks: sig });
  }
  return out;
}

/** Major version of a PostgreSQL `productVersion` ("17.2", "13.15"); null when unknown. */
function pgMajor(productVersion: string | null | undefined): number | null {
  const m = productVersion ? /^(\d+)/.exec(productVersion) : null;
  return m ? Number(m[1]) : null;
}

const PG_KINDS = new Set(['FUNCTION', 'PROCEDURE', 'VIEW', 'TRIGGER', 'AGGREGATE', 'RULE']);

/**
 * PostgreSQL: CREATE FUNCTION/PROCEDURE/VIEW/TRIGGER/AGGREGATE/RULE → CREATE OR REPLACE. Triggers need PostgreSQL 14
 * for OR REPLACE; on older servers `DROP TRIGGER IF EXISTS name ON table;` is prepended instead. A materialized view
 * has no OR REPLACE: `DROP MATERIALIZED VIEW IF EXISTS` is prepended. Types open as they are.
 */
function rewritePg(text: string, o: RewriteOptions): RewriteResult {
  if (o.type === 'type') return { text, changed: false, note: 'ALTER TYPE … ADD VALUE to extend an enum (CREATE TYPE cannot be replaced)' };
  const qualified = o.schema ? `${quotePg(o.schema)}.${quotePg(o.name)}` : quotePg(o.name);
  if (o.type === 'mview') {
    if (/^\s*DROP\s+MATERIALIZED\s+VIEW\b/i.test(text)) return { text, changed: false, note: null };
    const body = /;\s*$/.test(text) ? text.trimEnd() : `${text.trimEnd()};`;
    return { text: `DROP MATERIALIZED VIEW IF EXISTS ${qualified};\n${body}\n`, changed: true, note: 'DROP MATERIALIZED VIEW IF EXISTS prepended (no CREATE OR REPLACE)' };
  }
  const major = pgMajor(o.productVersion);
  const oldServer = major !== null && major < 14;
  const heads = createHeaders(text, o.dialect);
  const edits: { start: number; end: number; text: string }[] = [];
  const drops: string[] = [];
  const notes = new Set<string>();
  for (const { tok, toks } of heads) {
    const create = toks[tok];
    const next = toks[tok + 1];
    if (!next || next.upper === 'OR') continue;
    // CREATE [TEMP | TEMPORARY | RECURSIVE] VIEW; CREATE CONSTRAINT TRIGGER cannot be replaced.
    let k = tok + 1;
    while (toks[k] && /^(TEMP|TEMPORARY|RECURSIVE)$/.test(toks[k].upper)) k++;
    const kind = toks[k]?.upper;
    if (!kind || !PG_KINDS.has(kind)) continue;
    if (kind === 'TRIGGER' && oldServer) {
      // CREATE TRIGGER name … ON table
      const name = toks[k + 1]?.text;
      let on = k + 2;
      while (toks[on] && toks[on].upper !== 'ON' && toks[on].text !== ';') on++;
      const table = toks[on]?.upper === 'ON' ? tableRef(toks, on + 1) : null;
      if (name && table) drops.push(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
      notes.add('DROP TRIGGER IF EXISTS prepended (CREATE OR REPLACE TRIGGER needs PostgreSQL 14)');
      continue;
    }
    const upper = create.text === create.text.toUpperCase();
    edits.push({ start: create.start, end: create.end, text: `${create.text} ${upper ? 'OR REPLACE' : 'or replace'}` });
    notes.add('CREATE → CREATE OR REPLACE');
  }
  if (!edits.length && !drops.length) return { text, changed: false, note: null };
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (drops.length) out = `${drops.join('\n')}\n${out}`;
  return { text: out, changed: true, note: [...notes].join('; ') };
}

/** `schema.table` / `"Mixed".t` starting at token i (as written). */
function tableRef(toks: Token[], i: number): string | null {
  const parts: string[] = [];
  let j = i;
  while (toks[j] && (toks[j].kind === 'ident' || toks[j].kind === 'quotedIdent' || toks[j].kind === 'keyword')) {
    parts.push(toks[j].text);
    if (toks[j + 1]?.text !== '.') break;
    j += 2;
  }
  return parts.length ? parts.join('.') : null;
}

function quotePg(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

export function rewriteForEdit(ddl: string, o: RewriteOptions): RewriteResult {
  const text = ddl.replace(/\r\n/g, '\n');
  if (o.dialect === 'sqlite') return rewriteSqlite(text, o);
  if (o.dialect === 'pgsql') return rewritePg(text, o);
  const heads = createHeaders(text, o.dialect);
  if (!heads.length) return { text, changed: false, note: null };
  const edits: { start: number; end: number; text: string }[] = [];
  let note: string | null = null;
  for (const { tok, toks } of heads) {
    const create = toks[tok];
    const next = toks[tok + 1];
    if (!next) continue;
    if (o.dialect === 'tsql') {
      // CREATE OR ALTER x / CREATE x
      if (next.upper === 'OR') continue;
      if (!TSQL_KINDS.has(next.upper)) continue;
      if (supportsCreateOrAlter(o.productVersion)) {
        edits.push({ start: create.start, end: create.end, text: `${create.text} OR ALTER` });
        note = 'CREATE → CREATE OR ALTER';
      } else {
        edits.push({ start: create.start, end: create.end, text: create.text === 'create' ? 'alter' : 'ALTER' });
        note = 'CREATE → ALTER (server is older than SQL Server 2016 SP1)';
      }
    } else {
      // CREATE [OR REPLACE] [EDITIONABLE | NONEDITIONABLE | EDITIONING] kind
      if (next.upper === 'OR') continue;
      let k = tok + 1;
      while (toks[k] && /^(EDITIONABLE|NONEDITIONABLE|EDITIONING|FORCE|NOFORCE)$/.test(toks[k].upper)) k++;
      if (!toks[k] || !ORACLE_KINDS.has(toks[k].upper)) continue;
      const upper = create.text === create.text.toUpperCase();
      edits.push({ start: create.start, end: create.end, text: `${create.text} ${upper ? 'OR REPLACE' : 'or replace'}` });
      note = 'CREATE → CREATE OR REPLACE';
    }
  }
  if (!edits.length) return { text, changed: false, note: null };
  let out = text;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (o.dialect === 'plsql') out = ensureSlashes(out);
  return { text: out, changed: true, note };
}

/** Oracle PL/SQL units need a `/` line after their final `END …;` to run as separate statements in a script. */
function ensureSlashes(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const nextSig = lines.slice(i + 1).find((l) => l.trim() !== '');
    // A CREATE OR REPLACE following an END …; without a slash in between.
    if (/^\s*END\b[^;]*;\s*$/i.test(lines[i]) && nextSig !== undefined && /^\s*CREATE\b/i.test(nextSig)) out.push('/');
  }
  if (!/^\s*\/\s*$/.test(out[out.length - 1] ?? '') && /\bEND\b[^;]*;\s*$/i.test(out[out.length - 1] ?? '')) out.push('/');
  return out.join('\n') + '\n';
}

function rewriteSqlite(text: string, o: RewriteOptions): RewriteResult {
  const kind = o.type === 'view' ? 'VIEW' : o.type === 'trigger' ? 'TRIGGER' : null;
  if (!kind) return { text, changed: false, note: null };
  const head = text.trimStart();
  const qualified = o.schema && o.schema !== 'main' ? `${quote(o.schema)}.${quote(o.name)}` : quote(o.name);
  const drop = `DROP ${kind} IF EXISTS ${qualified};`;
  if (head.toUpperCase().startsWith(`DROP ${kind}`)) return { text, changed: false, note: null };
  const body = /;\s*$/.test(text) ? text.trimEnd() : `${text.trimEnd()};`;
  return { text: `${drop}\n${body}\n`, changed: true, note: `DROP ${kind} IF EXISTS prepended (SQLite has no CREATE OR REPLACE)` };
}

function quote(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/** Object types F4 opens as an editable script (tables and views have designers). */
export function isScriptEditable(type: CatalogObjectType, dialect: Dialect): boolean {
  if (type === 'proc' || type === 'func' || type === 'tablefunc' || type === 'package' || type === 'trigger' || type === 'type') return true;
  if (type === 'view' || type === 'mview') return dialect === 'plsql' || dialect === 'tsql' || dialect === 'sqlite' || dialect === 'pgsql';
  return false;
}
