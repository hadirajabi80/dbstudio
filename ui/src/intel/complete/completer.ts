// Completion by context (PLAN 4.7) with ranking (4.13) and quoting/case rules (4.8).
import type { CatalogObjectType, ObjectRef } from '../../api/types';
import type { CompletionItem, CompletionKind, CompletionResult, IntelOptions } from '../types';
import type { DialectSpec, FunctionDef } from '../dialect/spec';
import type { CursorContext } from '../context/context';
import type { CatalogIndex, ObjectEntry, SchemaEntry } from '../catalog/index';
import type { Binder, ResolvedSource, VisibleSource } from '../catalog/binder';
import { objectTypeLabel } from '../catalog/binder';
import type { ColumnDef, NamePart, Scope, TableRef, VarDef } from '../parse/statement-model';
import { formatIdent, formatObjectName, kwCase, snippetEscape, type FormatEnv } from './format';
import { matchScore, sortTextFor, type UsageStore } from './ranker';

export interface CompleteEnv {
  spec: DialectSpec;
  index: CatalogIndex;
  binder: Binder;
  opts: IntelOptions;
  usage: UsageStore;
  text: string;
  /** Statement start offset (for SELECT-before-FROM edits). */
  statementEnd: number;
  /** Extra completion sources (snippets, postfix templates); see ExtraCompletionSource. */
  extraSources?: readonly ExtraCompletionSource[];
}

/**
 * Hook for completion sources outside the completer (WP-H: snippets, postfix templates). A source returns ready
 * items (score/sortText set, matched against the prefix itself). Snippet items replace the completer's own
 * snippet with the same label, so user snippets can override the built-in ones.
 */
export type ExtraCompletionSource = (c: CursorContext, env: CompleteEnv) => CompletionItem[] | null | undefined;

const MAX_ITEMS = 2500;
const ALIAS_RESERVED = new Set(['AS', 'ON', 'IS', 'IN', 'OR', 'BY', 'DO', 'IF', 'TO', 'OF', 'GO', 'AT', 'NO', 'ALL', 'AND', 'ANY', 'ASC', 'END', 'FOR', 'KEY', 'NOT', 'SET', 'TOP', 'USE', 'ADD', 'DESC', 'FROM', 'FULL', 'INTO', 'JOIN', 'LEFT', 'NULL', 'OVER', 'PLAN', 'PROC', 'READ', 'RULE', 'SAVE', 'SOME', 'THEN', 'TRAN', 'USER', 'VIEW', 'WHEN', 'WITH']);

interface Add {
  label: string;
  kind: CompletionKind;
  group: number;
  relevance?: number;
  insertText?: string;
  filterText?: string;
  detail?: string;
  description?: string;
  documentation?: string;
  isSnippet?: boolean;
  command?: 'retrigger' | 'signatureHelp';
  usageKey?: string;
  ref?: ObjectRef;
  range?: [number, number];
  deprecated?: boolean;
  /** Match against this instead of the label (e.g. unquoted name). */
  matchText?: string;
  /** Always include, even when the prefix does not match (FK snippets matched by table name). */
  force?: boolean;
  /** Muted text right after the label (a routine's parameters). */
  labelDetail?: string;
  /** "Loading <schema>…" placeholder: the result is incomplete and refreshes when the catalog arrives. */
  loading?: boolean;
}

class Items {
  readonly list: CompletionItem[] = [];
  private readonly seen = new Set<string>();
  /** Catalog objects already offered as plain object items (FK-hoisted tables are not repeated). */
  private readonly objects = new Set<string>();
  capped = false;
  readonly c: CursorContext;
  readonly env: CompleteEnv;
  constructor(c: CursorContext, env: CompleteEnv) {
    this.c = c;
    this.env = env;
  }
  add(a: Add): void {
    const matchOn = a.matchText ?? a.filterText ?? a.label;
    const prefix = this.c.prefixText;
    let ms = matchScore(prefix, matchOn);
    if (prefix && ms < 0) {
      if (!a.force) return;
      ms = 0;
    }
    const insertText = a.insertText ?? a.label;
    if (a.ref && a.kind !== 'snippet' && a.kind !== 'column') {
      const ok = a.kind + '\u0000' + a.ref.schema + '.' + a.ref.name;
      if (this.objects.has(ok)) return;
      this.objects.add(ok);
    }
    const key = a.kind + '\u0000' + a.label + '\u0000' + insertText + '\u0000' + (a.detail ?? '');
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.list.length >= MAX_ITEMS) { this.capped = true; return; }
    const usage = this.env.usage.boost(a.usageKey);
    const score = a.group * 1000 + ms + usage + (a.relevance ?? 0) - (a.deprecated ? 20 : 0);
    let filterText = a.filterText ?? matchOn;
    if (this.c.prefixQuoted && !filterText.startsWith(this.c.prefixQuoted)) filterText = this.c.prefixQuoted + filterText;
    const item: CompletionItem = { label: a.label, kind: a.kind, insertText, sortText: sortTextFor(score), filterText, score };
    if (a.detail) item.detail = a.detail;
    if (a.description) item.description = a.description;
    if (a.labelDetail) item.labelDetail = a.labelDetail;
    if (a.loading) item.loading = true;
    if (a.documentation) item.documentation = a.documentation;
    if (a.isSnippet) item.isSnippet = true;
    if (a.command) item.command = a.command;
    if (a.usageKey) item.usageKey = a.usageKey;
    if (a.ref) item.ref = a.ref;
    if (a.range) item.range = a.range;
    else if (this.c.prefixQuoted && this.c.quoteCloseEnd !== null && !/^["`[]/.test(insertText)) item.range = [this.c.prefixStart, this.c.quoteCloseEnd];
    if (a.deprecated) item.deprecated = true;
    this.list.push(item);
  }
}

// ------------------------------------------------------------ helpers

/** Right-aligned detail of a catalog object: its schema first, then what it is (`dbo · table`). */
export function objectDetail(schema: string, type: CatalogObjectType): string {
  return `${schema} · ${objectTypeLabel(type)}`;
}

/**
 * Containers ranked above the plain tables (relevance 10) in a table-source context, so they show on the first screen
 * of suggestions however many tables the default schema has; the ones past this budget rank just below the tables
 * (a typed prefix or usage still brings them up). The default schema and the current database come first.
 */
export const TOP_CONTAINERS = 8;
/** Relevance of container items within the budget: other schemas > default schema > current database > other databases. */
const REL_SCHEMA = 24, REL_DEFAULT_SCHEMA = 22, REL_CURRENT_DB = 21, REL_DATABASE = 20, REL_OVER_BUDGET = 0;

/** `default schema`, `search_path schema` (PostgreSQL), `schema` / SQLite `database`. */
function schemaDetail(env: CompleteEnv, name: string): string {
  const { index, spec } = env;
  if (spec.id === 'sqlite') return index.isDefaultSchema(name) ? 'default database' : 'database';
  if (!index.isDefaultSchema(name)) return 'schema';
  return index.keyOfCatalog(name) === index.keyOfCatalog(index.defaultSchema) ? 'default schema' : 'search_path schema';
}

/**
 * Schema and database items (`name.`, retrigger) for a context that takes a qualified object name: every schema of the
 * database (loaded or not; `name.` lazy-loads one), the default schema included (SSMS / Navicat offer `dbo.`), and for
 * T-SQL the databases, the current one included (`shop.dbo.x`). Ranked per TOP_CONTAINERS.
 */
function containerItems(items: Items, c: CursorContext, env: CompleteEnv, group: number, opts: { databases?: boolean } = {}): void {
  const { index, spec } = env;
  const fe = fenv(c, env);
  interface Container { name: string; kind: 'schema' | 'database'; detail: string; rel: number; usageKey?: string }
  const schemas: Container[] = [];
  const seen = new Set<string>();
  const addSchema = (name: string) => {
    const k = index.keyOfCatalog(name);
    if (seen.has(k) || (spec.id === 'plsql' && k === 'PUBLIC')) return;
    seen.add(k);
    const def = index.isDefaultSchema(name);
    schemas.push({ name, kind: 'schema', detail: schemaDetail(env, name), rel: def ? REL_DEFAULT_SCHEMA : REL_SCHEMA, usageKey: 'schema:' + name });
  };
  for (const sc of index.schemas.values()) addSchema(sc.name);
  for (const name of index.unloadedSchemaNames()) addSchema(name);
  const dbs: Container[] = [];
  if (spec.id === 'tsql' && opts.databases !== false) {
    const cur = index.database ? index.keyOfCatalog(index.database) : null;
    for (const d of index.databases) {
      const isCur = cur !== null && index.keyOfCatalog(d) === cur;
      dbs.push({ name: d, kind: 'database', detail: isCur ? 'current database' : 'database', rel: isCur ? REL_CURRENT_DB : REL_DATABASE });
    }
  }
  // budget order: default schema(s), current database, other schemas, other databases (each as listed)
  const ordered = [
    ...schemas.filter((x) => x.rel === REL_DEFAULT_SCHEMA), ...dbs.filter((x) => x.rel === REL_CURRENT_DB),
    ...schemas.filter((x) => x.rel !== REL_DEFAULT_SCHEMA), ...dbs.filter((x) => x.rel !== REL_CURRENT_DB),
  ];
  ordered.forEach((x, i) => {
    items.add({
      label: x.name, kind: x.kind, group, relevance: i < TOP_CONTAINERS ? x.rel : REL_OVER_BUDGET, insertText: formatIdent(x.name, fe) + '.',
      command: 'retrigger', detail: x.detail, ...(x.usageKey ? { usageKey: x.usageKey } : {}),
    });
  });
}

/** T-SQL `USE |`: the databases (the name only: no dot, no retrigger); the current one last. */
function databaseNameItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const { index } = env;
  if (env.spec.id !== 'tsql') return;
  const fe = fenv(c, env);
  const cur = index.database ? index.keyOfCatalog(index.database) : null;
  for (const d of index.databases) {
    const isCur = cur !== null && index.keyOfCatalog(d) === cur;
    items.add({ label: d, kind: 'database', group: 9, relevance: isCur ? 0 : 10, insertText: formatIdent(d, fe), detail: isCur ? 'current database' : 'database' });
  }
}

/**
 * One "Loading <schema>…" row while a schema's objects are on their way (never an empty box): it matches whatever was
 * typed, inserts nothing new, and marks the result incomplete; the editor refreshes the list when the catalog arrives.
 */
function loadingItem(items: Items, c: CursorContext, name: string): void {
  items.add({ label: `Loading ${name}…`, kind: 'schema', group: 9, insertText: c.prefixText, filterText: c.prefixText, detail: 'loading objects', force: true, loading: true });
}

function fenv(c: CursorContext, env: CompleteEnv): FormatEnv {
  return { spec: env.spec, opts: env.opts, prefixText: c.prefixText, prefixQuoted: c.prefixQuoted, closingQuoteAfter: c.closingQuoteAfter };
}

function kindOfObject(t: CatalogObjectType): CompletionKind {
  switch (t) {
    case 'table': return 'table';
    case 'view': case 'mview': return 'view';
    case 'proc': return 'procedure';
    case 'func': case 'tablefunc': return 'function';
    case 'synonym': return 'synonym';
    case 'sequence': return 'sequence';
    case 'package': return 'package';
    default: return 'type';
  }
}

export function objectRef(index: CatalogIndex, e: ObjectEntry): ObjectRef {
  return { database: index.database, schema: e.schema, name: e.name, type: e.type };
}

function colDetail(label: string, src: ResolvedSource): string {
  return label && label !== src.shortName ? `${label} · ${src.shortName}` : src.shortName;
}

function colDoc(col: ColumnDef, owner: string): string {
  const flags: string[] = [];
  if (col.isPk) flags.push('PK');
  if (col.identity) flags.push('identity');
  if (col.computed) flags.push('computed');
  const nn = col.nullable === undefined ? '' : col.nullable ? ' NULL' : ' NOT NULL';
  let s = `\`${owner}.${col.name}\` ${col.type}${nn}${flags.length ? ' [' + flags.join(', ') + ']' : ''}`;
  if (col.comment) s += `\n\n${col.comment}`;
  return s;
}

function isRowidAlias(col: ColumnDef, cols: ColumnDef[], spec: DialectSpec): boolean {
  return spec.id === 'sqlite' && !!col.isPk && col.type.toUpperCase() === 'INTEGER' && cols.filter((c) => c.isPk).length === 1;
}

function insertable(col: ColumnDef, cols: ColumnDef[], spec: DialectSpec): boolean {
  return !col.identity && !col.computed && !col.hidden && !isRowidAlias(col, cols, spec);
}

/** Generate a unique alias: initials, then growing prefixes, then a number. */
export function makeAlias(name: string, taken: Set<string>, style: IntelOptions['aliasStyle']): string {
  const base = name.replace(/^[#@]+/, '');
  const segs = base.split(/[_\s$]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  const candidates: string[] = [];
  if (style === 'initials' && segs.length) candidates.push(segs.map((s) => s[0]).join('').toLowerCase());
  const lower = base.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
  for (let n = 1; n <= Math.min(lower.length, 6); n++) candidates.push(lower.slice(0, n));
  for (const cand of candidates) {
    if (!cand || /^\d/.test(cand)) continue;
    if (ALIAS_RESERVED.has(cand.toUpperCase())) continue;
    if (!taken.has(cand.toUpperCase())) return cand;
  }
  const stem = candidates[0] || 't';
  for (let i = 2; i < 1000; i++) if (!taken.has((stem + i).toUpperCase())) return stem + i;
  return stem;
}

function takenLabels(scope: Scope, binder: Binder): Set<string> {
  const s = new Set<string>();
  for (const v of binder.visibleSources(scope)) s.add(v.src.label.toUpperCase());
  return s;
}

function funcSignatureText(f: FunctionDef): string {
  const sig = f.signatures[0];
  if (f.kind === 'global' || f.kind === 'niladic') return f.returns ? `${f.returns}` : '';
  return `(${(sig?.params ?? []).join(', ')})${sig?.returns ?? f.returns ? ' → ' + (sig?.returns ?? f.returns) : ''}`;
}

export function functionDoc(f: FunctionDef): string {
  const lines = [f.doc];
  if (f.signatures.length > 1 || (f.kind !== 'global' && f.kind !== 'niladic')) {
    lines.push('');
    for (const s of f.signatures) lines.push('`' + f.name + '(' + s.params.join(', ') + ')' + (s.returns ? ' → ' + s.returns : '') + '`' + (s.doc ? ' — ' + s.doc : ''));
  }
  if (f.since) lines.push('', `_Since ${f.since}_`);
  if (f.deprecated) lines.push('', '**Deprecated**');
  return lines.join('\n');
}

export function paramsText(params: [string, string, string, number][], spec: DialectSpec): string {
  if (spec.id === 'pgsql') return params.filter((p) => p[2] !== 'return').map((p) => pgParamText(p)).join(', ');
  return params.filter((p) => p[2] !== 'return').map((p) => {
    const dir = p[2] === 'in' ? (spec.id === 'plsql' ? ' IN' : '') : p[2] === 'out' ? (spec.id === 'plsql' ? ' OUT' : ' OUTPUT') : p[2] === 'inout' ? ' IN OUT' : '';
    return spec.id === 'plsql' ? `${p[0]}${dir} ${p[1]}`.trim() : `${p[0]} ${p[1]}${dir}`.trim();
  }).join(', ');
}

/** PostgreSQL parameter: `[OUT |INOUT ]name type` (input parameters without a mode, as pg_get_function_arguments). */
export function pgParamText(p: [string, string, string, number]): string {
  const mode = p[2] === 'out' ? 'OUT ' : p[2] === 'inout' ? 'INOUT ' : '';
  return `${mode}${p[0]} ${p[1]}`.trim() + (p[3] ? ' DEFAULT …' : '');
}

// ------------------------------------------------------------ main entry

export function complete(c: CursorContext, env: CompleteEnv): CompletionResult {
  const items = new Items(c, env);
  const replaceRange: [number, number] = [c.prefixStart, c.offset];
  let isIncomplete = false;

  if (c.qualifier) {
    isIncomplete = qualifierItems(items, c, env) || isIncomplete;
  } else if (c.prefix.startsWith('@') && (env.spec.id === 'tsql' || env.spec.id === 'mysql')) {
    if (env.spec.id === 'tsql') variableItems(items, c, env, 9);
    globalVarItems(items, c, env);
  } else if (c.atStatementStart) {
    statementStartItems(items, c, env);
  } else if (!followerItems(items, c, env)) {
    isIncomplete = clauseItems(items, c, env) || isIncomplete;
  }

  // Oracle: unknown identifiers might be PUBLIC synonyms (lazy)
  if (env.spec.id === 'plsql' && !c.qualifier && c.prefixText.length >= 2 && ['from', 'join', 'update', 'delete', 'into', 'using', 'unknown', 'select', 'where'].includes(c.clause)) {
    const name = c.prefixQuoted ? c.prefixText : c.prefixText.toUpperCase();
    if (!env.index.lookupAll({ text: name, quoted: true }).length) {
      const r = env.index.requestPublicSynonym(name);
      if (r === undefined && env.index.publicResolver) isIncomplete = true;
    }
  }

  let list = items.list;
  for (const src of env.extraSources ?? []) {
    const extra = src(c, env);
    if (!extra || !extra.length) continue;
    const replaced = new Set(extra.filter((i) => i.kind === 'snippet').map((i) => i.label.toUpperCase()));
    list = list.filter((i) => !(i.kind === 'snippet' && replaced.has(i.label.toUpperCase()))).concat(extra);
  }
  list.sort((a, b) => b.score - a.score || a.label.length - b.label.length || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  return { items: list, isIncomplete: isIncomplete || items.capped, replaceRange };
}

// ------------------------------------------------------------ keyword followers

/**
 * DialectSpec.keywordFollowers (Batch 3): after `CONSISTENCY` the levels, after `DESCRIBE TABLE` the tables… Looked
 * up: the two words before the cursor, then the last one; a `^` key only matches at the start of the statement.
 * False when nothing is declared for them.
 */
function followerItems(items: Items, c: CursorContext, env: CompleteEnv): boolean {
  const map = env.spec.keywordFollowers;
  const p = c.prevToken;
  const word = (t: { kind: string } | null | undefined) => !!t && (t.kind === 'keyword' || t.kind === 'ident');
  if (!map || !word(p)) return false;
  const toks = c.statement.tokens;
  const at = toks.indexOf(p!);
  const two = at > 0 && word(toks[at - 1]) ? toks[at - 1].upper + ' ' + p!.upper : null;
  const list = (two && at === 1 ? map['^' + two] : undefined) ?? (two ? map[two] : undefined) ?? (at === 0 ? map['^' + p!.upper] : undefined) ?? map[p!.upper];
  if (!list) return false;
  const fe = fenv(c, env);
  list.forEach((k, i) => {
    if (k === '@keyspace') {
      for (const sc of env.index.schemas.values()) items.add({ label: sc.name, kind: 'schema', group: 10, insertText: formatIdent(sc.name, fe), detail: schemaDetail(env, sc.name) });
      for (const name of env.index.unloadedSchemaNames()) items.add({ label: name, kind: 'schema', group: 10, insertText: formatIdent(name, fe), detail: schemaDetail(env, name) });
    } else if (k === '@table') tableItems(items, c, env, 9);
    else items.add({ label: kwCase(k, env.opts), kind: 'keyword', group: 10, relevance: Math.max(0, 40 - i), usageKey: 'kw:' + k });
  });
  return true;
}

// ------------------------------------------------------------ statement start

function statementStartItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const { spec, opts } = env;
  spec.startKeywords.forEach((k, i) => items.add({ label: kwCase(k, opts), kind: 'keyword', group: 9, relevance: Math.max(0, 40 - i), usageKey: 'kw:' + k }));
  for (const s of spec.snippets) items.add({ label: s.label, kind: 'snippet', group: 8, insertText: s.body, isSnippet: true, detail: s.doc, documentation: '```sql\n' + s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d/g, '').replace(/\\\$/g, '$') + '\n```', usageKey: 'snip:' + s.prefix });
  // inside blocks (PL/SQL, T-SQL BEGIN/END): procedural statements
  if (spec.id === 'plsql' && c.scope.kind === 'plsqlBlock') {
    for (const k of ['IF', 'FOR', 'LOOP', 'WHILE', 'NULL', 'RETURN', 'RAISE', 'EXIT', 'OPEN', 'FETCH', 'CLOSE', 'EXECUTE IMMEDIATE', 'COMMIT', 'ROLLBACK', 'END', 'EXCEPTION', 'CASE']) {
      items.add({ label: kwCase(k, opts), kind: 'keyword', group: 9 });
    }
    variableItems(items, c, env, 7);
    packageItems(items, c, env, 6);
  }
  if (spec.id === 'tsql' && c.scope.parent === null && c.scope.kind === 'other' && env.binder.variables(c.scope).length) {
    variableItems(items, c, env, 6);
  }
  // tables: accepting inserts `SELECT * FROM table` (DataGrip style)
  if (c.prefixText) {
    const fe = fenv(c, env);
    for (const e of env.index.defaultObjects()) {
      if (!e.isTabular && e.type !== 'synonym') continue;
      const name = formatObjectName(e.schema, e.name, true, fe);
      items.add({
        label: e.name, kind: kindOfObject(e.type), group: 5, matchText: e.name, filterText: e.name,
        insertText: `${kwCase('SELECT', opts)} * ${kwCase('FROM', opts)} ${name.replace(/^[[`"]/, (m) => (c.prefixQuoted ? m : m))}`,
        detail: `${kwCase('SELECT', opts)} * ${kwCase('FROM', opts)} ${e.name}`, ref: objectRef(env.index, e), usageKey: 'obj:' + e.qualifiedName,
      });
    }
  }
}

// ------------------------------------------------------------ clauses

function clauseItems(items: Items, c: CursorContext, env: CompleteEnv): boolean {
  const { spec, opts } = env;
  let incomplete = false;
  const scope = c.scope;
  // a new statement keyword typed at the start of a line (SSMS style scripts without `;`)
  const offerStarts = () => {
    if (c.firstOnLine && c.prefixText) for (const k of spec.startKeywords) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 3 });
  };
  switch (c.clause) {
    case 'select': {
      if (c.afterOperand && !c.inFunctionCall) {
        if (spec.id === 'pgsql') jsonOperatorItems(items, c, env);
        for (const k of ['FROM', 'AS', ...(spec.id === 'tsql' || spec.id === 'plsql' ? ['INTO'] : []), 'CASE', 'OVER']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 9 });
        for (const k of spec.afterExprKeywords) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 6 });
        columnItems(items, c, env, 5);
        functionItems(items, c, env, 4);
        offerStarts();
        break;
      }
      if (!c.statementHasFrom && scope.sources.length === 0) {
        incomplete = selectWithoutFrom(items, c, env) || incomplete;
      } else {
        columnItems(items, c, env, 10);
        sourceLabelItems(items, c, env, 9);
        starItems(items, c, env, 8);
        allColumnsItems(items, c, env, 3);
      }
      functionItems(items, c, env, 6);
      for (const k of spec.selectKeywords) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 5 });
      variableItems(items, c, env, 4);
      packageItems(items, c, env, 4);
      sequenceItems(items, c, env, 3);
      break;
    }
    case 'from': case 'join': case 'update': case 'delete': case 'into': case 'using': {
      if (c.clause === 'into' && c.marker?.data?.selectInto) {
        if (spec.id === 'plsql') variableItems(items, c, env, 9);
        else tempTableItems(items, c, env, 9);
        break;
      }
      if (c.afterSource || c.aliasTyping) {
        const list = c.clause === 'update' ? ['SET'] : c.clause === 'delete' ? ['WHERE', 'FROM'] : c.clause === 'into' ? ['VALUES', 'SELECT', 'DEFAULT VALUES', '('] : c.clause === 'using' ? ['ON'] : spec.afterSourceKeywords;
        list.forEach((k, i) => { if (k !== '(') items.add({ label: kwCase(k, opts), kind: 'keyword', group: 10, relevance: Math.max(0, 40 - i), usageKey: 'kw:' + k }); });
        if (c.clause === 'join') items.add({ label: kwCase('ON', opts), kind: 'keyword', group: 10, relevance: 50 });
        offerStarts();
        break;
      }
      if (c.clause === 'join') joinItems(items, c, env);
      tableItems(items, c, env, c.clause === 'join' ? 7 : 8);
      if (c.prefixText && spec.id === 'tsql') {
        for (const f of spec.functions) if (f.kind === 'table') items.add({ label: spec.preserveNameCase ? f.name : kwCase(f.name, opts), kind: 'function', group: 3, insertText: (spec.preserveNameCase ? f.name : kwCase(f.name, opts)) + '($0)', isSnippet: true, command: 'signatureHelp', detail: funcSignatureText(f), documentation: functionDoc(f) });
      }
      if (c.prefixText && (spec.id === 'sqlite' || spec.id === 'pgsql')) {
        // set-returning functions in FROM (generate_series, unnest, jsonb_each …)
        for (const f of spec.functions) if (f.kind === 'table') items.add({ label: f.name, kind: 'function', group: 3, insertText: f.name + '($0)', isSnippet: true, command: 'signatureHelp', detail: funcSignatureText(f), documentation: functionDoc(f) });
      }
      break;
    }
    case 'on': {
      if (c.afterOperand) {
        expressionKeywords(items, c, env, 10);
        columnItems(items, c, env, 6);
        break;
      }
      onConditionItems(items, c, env);
      columnItems(items, c, env, 9);
      sourceLabelItems(items, c, env, 7);
      functionItems(items, c, env, 5);
      expressionKeywords(items, c, env, 4);
      break;
    }
    case 'where': case 'having': case 'groupBy': case 'orderBy': case 'limit': case 'returning': {
      if (c.afterOperand && !c.inFunctionCall) {
        if (spec.id === 'pgsql') jsonOperatorItems(items, c, env);
        expressionKeywords(items, c, env, 10);
        columnItems(items, c, env, 6);
        sourceLabelItems(items, c, env, 5);
        functionItems(items, c, env, 4);
        offerStarts();
        break;
      }
      columnItems(items, c, env, 9);
      sourceLabelItems(items, c, env, 7);
      if (c.clause === 'orderBy') projectionAliasItems(items, c, env, 9);
      if (c.clause === 'returning') starItems(items, c, env, 8);
      functionItems(items, c, env, 5);
      for (const k of ['NOT', 'EXISTS', 'NULL', 'CASE', 'CAST']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 4 });
      variableItems(items, c, env, 4);
      packageItems(items, c, env, 3);
      sequenceItems(items, c, env, 3);
      break;
    }
    case 'set': {
      if (c.setLhs) {
        const tgt = env.binder.target(scope);
        if (tgt) {
          const cols = tgt.columns();
          for (const col of cols) {
            if (!insertable(col, cols, spec)) continue;
            items.add({ label: col.name, kind: 'column', group: 9, relevance: 10 + Math.max(0, 200 - col.ordinal), insertText: formatIdent(col.name, fenv(c, env)), detail: tgt.shortName, description: col.type, documentation: colDoc(col, tgt.display), usageKey: `col:${tgt.shortName}.${col.name}` });
          }
        }
        break;
      }
      if (c.afterOperand) { expressionKeywords(items, c, env, 9); columnItems(items, c, env, 6); break; }
      if (spec.id === 'pgsql' && scope.kind === 'insert') excludedItems(items, c, env);
      columnItems(items, c, env, 9);
      functionItems(items, c, env, 5);
      variableItems(items, c, env, 5);
      for (const k of ['NULL', 'DEFAULT', 'CASE']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 4 });
      break;
    }
    case 'insertColumns': insertColumnItems(items, c, env); break;
    case 'values': valuesItems(items, c, env); break;
    case 'exec': execItems(items, c, env); break;
    case 'execArgs': execArgItems(items, c, env); break;
    case 'use': {
      // `USE |` → databases; `USE Shop |` → (a new statement on the next line)
      if (c.prevToken?.upper === 'USE') databaseNameItems(items, c, env);
      else offerStarts();
      break;
    }
    case 'with': case 'cteColumns': {
      if (c.clause === 'with' && c.prevToken && (c.prevToken.kind === 'ident' || c.prevToken.kind === 'quotedIdent' || c.prevToken.text === ')')) {
        items.add({ label: kwCase('AS', opts), kind: 'keyword', group: 9 });
      }
      if (c.clause === 'with' && c.prevToken && c.prevToken.text === ')' ) {
        for (const k of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 8 });
      }
      break;
    }
    case 'declare': {
      if (c.marker?.data?.expectType) {
        dataTypeItems(items, c, env, 9);
        if (spec.id === 'plsql') { tableItems(items, c, env, 6); }
        if (spec.id === 'tsql') { items.add({ label: kwCase('TABLE', opts), kind: 'keyword', group: 8 }); items.add({ label: kwCase('CURSOR', opts), kind: 'keyword', group: 7 }); }
      } else if (spec.id === 'plsql') {
        for (const k of ['CURSOR', 'TYPE', 'PROCEDURE', 'FUNCTION', 'PRAGMA', 'BEGIN']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 6 });
      }
      break;
    }
    case 'ddl': ddlItems(items, c, env); break;
    case 'cast': castItems(items, c, env); break;
    case 'expr': {
      if (c.afterOperand && !c.inFunctionCall) { expressionKeywords(items, c, env, 8); }
      variableItems(items, c, env, 9);
      functionItems(items, c, env, 7);
      packageItems(items, c, env, 7);
      sequenceItems(items, c, env, 5);
      columnItems(items, c, env, 6);
      for (const k of ['NULL', 'NOT', 'CASE', 'EXISTS', 'SELECT', ...(spec.id === 'plsql' ? ['TRUE', 'FALSE', 'SQL%ROWCOUNT', 'SQLERRM', 'SQLCODE'] : [])]) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 4 });
      if (c.marker?.data?.statementStart) statementStartItems(items, c, env);
      break;
    }
    case 'unknown': default: {
      // after INSERT INTO t (cols) / VALUES (...) / MERGE WHEN ...
      const conflict = c.marker?.data?.conflict;
      if (scope.kind === 'insert' && conflict) {
        const list = conflict === 'target' ? ['(', 'ON CONSTRAINT', 'DO NOTHING', 'DO UPDATE SET'] : conflict === 'do' ? ['NOTHING', 'UPDATE SET'] : ['DO NOTHING', 'DO UPDATE SET', 'WHERE'];
        list.forEach((k, i) => { if (k !== '(') items.add({ label: kwCase(k, opts), kind: 'keyword', group: 10, relevance: 20 - i }); });
        break;
      }
      if (scope.kind === 'insert') {
        for (const k of ['VALUES', 'SELECT', 'DEFAULT VALUES', ...(spec.id === 'tsql' ? ['OUTPUT', 'EXEC'] : []), ...(spec.id === 'sqlite' || spec.id === 'pgsql' ? ['ON CONFLICT', 'RETURNING'] : []), ...(spec.id === 'pgsql' ? ['OVERRIDING SYSTEM VALUE'] : [])]) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 9 });
      } else if (scope.kind === 'merge') {
        for (const k of ['WHEN MATCHED THEN', 'WHEN NOT MATCHED THEN', 'UPDATE SET', 'INSERT', 'DELETE', 'AND']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 9 });
      } else {
        for (const k of spec.startKeywords) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 6 });
        tableItems(items, c, env, 3);
      }
      functionItems(items, c, env, 3);
      break;
    }
  }
  // signature-aware named arguments (Oracle `p_total => `)
  if (c.inFunctionCall && !c.qualifier) namedArgItems(items, c, env);
  return incomplete;
}

function expressionKeywords(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const { spec, opts } = env;
  let list = spec.afterExprKeywords;
  if (c.clause === 'orderBy') list = ['ASC', 'DESC', ...(spec.id !== 'tsql' ? ['NULLS FIRST', 'NULLS LAST'] : []), ...(spec.id === 'pgsql' ? ['USING'] : []), ...list.filter((k) => !/^(AND|OR|NOT|IN|IS|LIKE|ILIKE|SIMILAR|BETWEEN|GLOB|FILTER|OVER)\b/.test(k) && k !== 'ORDER BY' && k !== 'GROUP BY')];
  else if (c.clause === 'groupBy') list = ['HAVING', 'ORDER BY', ...(spec.id === 'tsql' ? ['WITH ROLLUP'] : spec.id === 'pgsql' ? ['ROLLUP (', 'CUBE (', 'GROUPING SETS ('] : ['ROLLUP', 'CUBE']), ...list.filter((k) => k !== 'GROUP BY' && !/^(AND|OR|NOT|IN|IS|LIKE|ILIKE|SIMILAR|BETWEEN|GLOB|FILTER|OVER)\b/.test(k))];
  else if (c.clause === 'on') list = ['AND', 'OR', 'WHERE', 'INNER JOIN', 'LEFT JOIN', 'JOIN', 'GROUP BY', 'ORDER BY', 'IS NULL', 'IS NOT NULL', 'IN', 'LIKE', 'BETWEEN'];
  else if (c.clause === 'having') list = list.filter((k) => k !== 'GROUP BY' && k !== 'HAVING');
  else if (c.clause === 'expr') list = ['AND', 'OR', 'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', ...(spec.id === 'plsql' ? ['THEN', 'LOOP'] : [])];
  let rel = 30;
  for (const k of list) items.add({ label: kwCase(k, opts), kind: 'keyword', group, relevance: rel > 0 ? rel-- : 0, usageKey: 'kw:' + k });
}

// ------------------------------------------------------------ columns / sources

/** Most recently referenced alias before the cursor in this scope (`c.Name = ... AND |` → c). */
function recentLabel(c: CursorContext): string | null {
  if (c.afterJoinTable) return c.afterJoinTable.alias ?? c.afterJoinTable.parts[c.afterJoinTable.parts.length - 1]?.text ?? null;
  let best: { end: number; label: string } | null = null;
  for (const ch of c.statement.chains) {
    if (ch.parts.length < 2 || ch.range[1] > c.chainStart || ch.isCall) continue;
    if (ch.range[0] < c.scope.range[0] || ch.range[1] > c.scope.range[1]) continue;
    if (!best || ch.range[1] > best.end) best = { end: ch.range[1], label: ch.parts[ch.parts.length - 2].text };
  }
  return best?.label ?? null;
}

function columnItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const vis = env.binder.visibleSources(c.scope);
  if (!vis.length) return;
  const fe = fenv(c, env);
  const counts = new Map<string, number>();
  for (const v of vis) {
    for (const col of v.src.columns()) {
      const k = env.index.keyOfCatalog(col.name).toUpperCase();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const recent = recentLabel(c);
  const recentKey = recent ? env.index.keyOf(recent, false) : null;
  const pkBonus = c.clause === 'on' || c.clause === 'where';
  const targetLabel = c.scope.targetTable ? env.binder.target(c.scope)?.label : null;
  for (const v of vis) {
    const src = v.src;
    const cols = src.columns();
    const isRecent = recentKey !== null && env.index.keyOf(src.label, !!src.ref.aliasQuoted) === recentKey;
    const multi = vis.length > 1;
    for (const col of cols) {
      if (col.hidden && !c.prefixText) continue;
      const k = env.index.keyOfCatalog(col.name).toUpperCase();
      const ambiguous = v.level > 0 || (counts.get(k) ?? 0) > 1; // same name in another visible source (incl. outer scopes)
      const qualify = ambiguous || env.opts.qualifyColumns === 'always';
      const colText = formatIdent(col.name, fe, !qualify);
      const insertText = qualify ? `${formatIdent(src.label, fe, true)}.${colText}` : colText;
      let relevance = -10 * v.level;
      if (isRecent) relevance += 15;
      if (pkBonus && col.isPk) relevance += 3;
      if (targetLabel && src.label === targetLabel && (c.scope.kind === 'insert' || c.scope.kind === 'update')) relevance += 10;
      relevance += Math.max(0, 200 - col.ordinal) / 100; // ordinal order as the final tie-breaker
      items.add({
        label: col.name, kind: 'column', group, relevance, insertText, filterText: col.name,
        detail: multi || src.ref.alias ? colDetail(src.label, src) : src.shortName, description: col.type,
        documentation: colDoc(col, src.display), usageKey: `col:${src.shortName}.${col.name}`,
      });
    }
  }
}

function sourceLabelItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const fe = fenv(c, env);
  for (const v of env.binder.visibleSources(c.scope)) {
    const src = v.src;
    items.add({
      label: src.label, kind: src.ref.alias ? 'alias' : src.cte ? 'cte' : 'table', group, relevance: -5 * v.level,
      insertText: formatIdent(src.label, fe), detail: src.ref.alias ? `alias → ${src.display}` : src.display,
      command: undefined,
    });
  }
}

function starItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const vis = env.binder.visibleSources(c.scope).filter((v) => v.level === 0);
  if (c.prefixText) return;
  items.add({ label: '*', kind: 'operator', group, insertText: '*', detail: 'all columns', filterText: '*' });
  if (vis.length > 1 || (vis.length === 1 && vis[0].src.ref.alias)) {
    const fe = fenv(c, env);
    for (const v of vis) items.add({ label: `${v.src.label}.*`, kind: 'operator', group, relevance: -1, insertText: `${formatIdent(v.src.label, fe)}.*`, detail: v.src.display });
  }
}

/** DataGrip-style "all columns of X" expansion. */
function allColumnsItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const vis = env.binder.visibleSources(c.scope).filter((v) => v.level === 0);
  const fe = fenv(c, env);
  const qualify = vis.length > 1;
  for (const v of vis) {
    const cols = v.src.columns().filter((col) => !col.hidden);
    if (!cols.length) continue;
    const text = cols.map((col) => (qualify ? `${formatIdent(v.src.label, fe)}.${formatIdent(col.name, fe, false)}` : formatIdent(col.name, fe, false))).join(', ');
    items.add({
      label: `${v.src.label}.* (all columns)`, kind: 'snippet', group, insertText: text, detail: `${cols.length} columns of ${v.src.display}`,
      filterText: v.src.label, documentation: '```sql\n' + text + '\n```', force: false,
    });
  }
}

function projectionAliasItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const fe = fenv(c, env);
  let s: Scope | null = c.scope;
  // ORDER BY after a UNION applies to the first branch's output names
  while (s && s.isBranch && s.parent) s = s.parent;
  for (const p of s?.projections ?? []) {
    if (p.alias) items.add({ label: p.alias, kind: 'alias', group, relevance: 8, insertText: formatIdent(p.alias, fe), detail: 'column alias' });
  }
  const n = s?.projections.length ?? 0;
  if (n > 1 && !c.prefixText) items.add({ label: '1', kind: 'keyword', group: 2, detail: `ordinal (1..${n})` });
}

/** SELECT list before FROM: columns of all default-schema tables; accepting appends `FROM table`. */
function selectWithoutFrom(items: Items, c: CursorContext, env: CompleteEnv): boolean {
  const defObjects = env.index.defaultObjects();
  if (!env.index.defaultEntries().length) return false;
  const fe = fenv(c, env);
  let count = 0;
  let capped = false;
  for (const e of defObjects) {
    if (!e.isTabular) continue;
    const tableText = formatObjectName(e.schema, e.name, true, fe);
    items.add({ label: e.name, kind: kindOfObject(e.type), group: 8, insertText: formatIdent(e.name, fe), detail: objectTypeLabel(e.type), ref: objectRef(env.index, e), usageKey: 'obj:' + e.qualifiedName });
    for (const col of e.columns()) {
      if (count >= env.opts.maxColumnsWithoutFrom) { capped = true; break; }
      if (col.hidden) continue;
      if (c.prefixText && matchScore(c.prefixText, col.name) < 0) continue;
      count++;
      const colText = formatIdent(col.name, fe);
      const insertText = c.statementEndsAtCursor
        ? `${snippetEscape(colText)}$0 ${kwCase('FROM', env.opts)} ${snippetEscape(tableText)}`
        : colText;
      items.add({
        label: col.name, kind: 'column', group: 9, insertText, isSnippet: c.statementEndsAtCursor, filterText: col.name,
        detail: e.name, description: col.type, documentation: colDoc(col, e.qualifiedName), usageKey: `col:${e.name}.${col.name}`,
      });
    }
    if (capped) break;
  }
  return capped;
}

// ------------------------------------------------------------ tables

function backwardInference(c: CursorContext, env: CompleteEnv): Set<ObjectEntry> | null {
  // SELECT Name, Price FROM |  → tables having these columns
  const names: NamePart[] = [];
  for (const p of c.scope.projections) if (p.colRef && p.colRef.qualifier.length === 0) names.push(p.colRef.name);
  if (!names.length) return null;
  const out = new Set<ObjectEntry>();
  const first = env.index.tablesWithColumn(names[0]);
  for (const e of first) {
    if (names.every((n) => e.column(env.index.keyOf(n.text, n.quoted)))) out.add(e);
  }
  return out;
}

function tableItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const { index, spec } = env;
  const fe = fenv(c, env);
  const scope = c.scope;
  // CTEs
  const seenCte = new Set<string>();
  for (let s: Scope | null = scope; s; s = s.parent) {
    for (const cte of s.ctes) {
      if (seenCte.has(cte.name.toUpperCase())) continue;
      seenCte.add(cte.name.toUpperCase());
      items.add({ label: cte.name, kind: 'cte', group: group + 1, insertText: formatIdent(cte.name, fe), detail: 'cte', documentation: env.binder.cteColumns(cte).map((x) => x.name).join(', ') });
    }
  }
  const inferred = c.clause === 'from' && !c.qualifier ? backwardInference(c, env) : null;
  const defObjects = index.defaultObjects();
  const tabular = (e: ObjectEntry) => e.isTabular || e.type === 'synonym';
  for (const e of defObjects) {
    if (!tabular(e)) continue;
    let relevance = 10;
    if (inferred?.has(e)) relevance += 25;
    const g = e.type === 'synonym' ? group - 2 : group;
    const target = e.type === 'synonym' ? index.followSynonym(e) : null;
    items.add({
      label: e.name, kind: kindOfObject(e.type), group: g, relevance, insertText: formatObjectName(e.schema, e.name, true, fe),
      filterText: e.name, detail: e.type === 'synonym' ? `→ ${target ? target.qualifiedName : (e.obj.target ? `${e.obj.target.s ?? ''}.${e.obj.target.n}` : '?')}` : objectDetail(e.schema, e.type),
      documentation: e.obj.cm ?? undefined, ref: objectRef(index, e), usageKey: 'obj:' + e.qualifiedName,
    });
  }
  // Oracle: PUBLIC synonyms + built-ins (DUAL)
  if (spec.id === 'plsql') {
    const pub = index.schema('PUBLIC', true);
    for (const e of [...(pub?.objects ?? []), ...index.publicSynonyms()]) {
      items.add({ label: e.name, kind: 'synonym', group: group - 2, insertText: formatIdent(e.name, fe), detail: 'public synonym', ref: objectRef(index, e) });
    }
    const dual = index.builtin({ text: 'DUAL', quoted: true });
    if (dual && c.prefixText) items.add({ label: 'DUAL', kind: 'table', group: group - 1, insertText: formatIdent('DUAL', fe), detail: 'SYS.DUAL (public synonym)' });
  }
  tempTableItems(items, c, env, group);
  // schemas (the default one too, loaded or not) and T-SQL databases, on the first screen next to the tables
  containerItems(items, c, env, group);
  // objects of the other loaded schemas when something has been typed
  for (const sc of index.schemas.values()) {
    if (index.isDefaultSchema(sc.name)) continue;
    if (spec.id === 'plsql' && sc.name === 'PUBLIC') continue;
    if (c.prefixText) {
      for (const e of sc.objects) {
        if (!tabular(e)) continue;
        const rel = inferred?.has(e) ? 15 : -10;
        items.add({
          label: `${sc.name}.${e.name}`, kind: kindOfObject(e.type), group, relevance: rel, matchText: e.name, filterText: `${sc.name}.${e.name}`,
          insertText: formatIdent(sc.name, fe) + '.' + formatIdent(e.name, fe, false), detail: objectDetail(sc.name, e.type),
          ref: objectRef(index, e), usageKey: 'obj:' + e.qualifiedName,
        });
      }
    }
  }
  // PostgreSQL: pg_catalog views resolve unqualified (below the user's tables); information_schema by prefix
  if (spec.id === 'pgsql') {
    for (const sc of index.builtinSchemaList()) {
      const implicit = sc.name === 'pg_catalog';
      items.add({ label: sc.name, kind: 'schema', group: group - 4, insertText: formatIdent(sc.name, fe) + '.', command: 'retrigger', detail: 'system schema', usageKey: 'schema:' + sc.name });
      if (!implicit && !c.prefixText) continue;
      for (const e of sc.objects) {
        items.add({
          label: implicit ? e.name : `${sc.name}.${e.name}`, kind: kindOfObject(e.type), group: group - 3, relevance: -5, matchText: e.name,
          filterText: implicit ? e.name : `${sc.name}.${e.name}`, insertText: implicit ? formatIdent(e.name, fe) : formatIdent(sc.name, fe) + '.' + formatIdent(e.name, fe, false),
          detail: objectDetail(sc.name, e.type), documentation: e.obj.cm ?? undefined,
        });
      }
    }
  }
  // user table functions
  for (const e of defObjects) {
    if (e.type !== 'tablefunc') continue;
    items.add({ label: e.name, kind: 'function', group: group - 4, insertText: formatObjectName(e.schema, e.name, true, fe) + '($0)', isSnippet: true, command: 'signatureHelp', detail: `(${paramsText(e.params(), spec)})`, labelDetail: `(${paramsText(e.params(), spec)})`, description: objectDetail(e.schema, e.type), ref: objectRef(index, e) });
  }
}

function tempTableItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const fe = fenv(c, env);
  for (const t of env.binder.symbols.tables.values()) {
    if (t.kind === 'table' && env.index.resolve(t.parts ?? [{ text: t.name, quoted: false }])) continue;
    items.add({ label: t.name, kind: 'table', group, relevance: 5, insertText: t.name.startsWith('#') || t.name.startsWith('@') ? t.name : formatIdent(t.name, fe), detail: t.kind === 'tempTable' ? 'temp table' : t.kind === 'tableVar' ? 'table variable' : 'table (script)' });
  }
  for (const v of env.binder.variables(c.scope)) {
    if (v.kind === 'tableVar') items.add({ label: v.name, kind: 'variable', group, relevance: 5, insertText: v.name, detail: 'table variable' });
  }
}

// ------------------------------------------------------------ joins

interface FkCond { text: string; fkName: string; cols: number }

function fkConditions(cand: ObjectEntry, candLabel: string, src: ResolvedSource, env: CompleteEnv, fe: FormatEnv): FkCond[] {
  const out: FkCond[] = [];
  if (!src.entry) return out;
  for (const { edge, aIsFrom } of env.index.fkBetween(cand, src.entry)) {
    const pairs: string[] = [];
    for (let i = 0; i < edge.fromCols.length; i++) {
      const fromCol = edge.fromCols[i], toCol = edge.toCols[i] ?? edge.toCols[0];
      const candCol = aIsFrom ? fromCol : toCol;
      const srcCol = aIsFrom ? toCol : fromCol;
      pairs.push(`${formatIdent(candLabel, fe, false)}.${formatIdent(candCol, fe, false)} = ${formatIdent(src.label, fe, false)}.${formatIdent(srcCol, fe, false)}`);
    }
    out.push({ text: pairs.join(` ${kwCase('AND', env.opts)} `), fkName: edge.name, cols: pairs.length });
  }
  return out;
}

function joinItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const { index } = env;
  const fe = fenv(c, env);
  // sources before this JOIN in the same scope
  const prior = env.binder.ownSources(c.scope).filter((s) => s.ref.range[1] <= c.prefixStart);
  if (!prior.length) return;
  const taken = takenLabels(c.scope, env.binder);
  const candidates = new Map<ObjectEntry, ResolvedSource[]>();
  for (const s of prior) {
    if (!s.entry) continue;
    for (const e of s.entry.fksOut) if (e.to) { const arr = candidates.get(e.to) ?? []; arr.push(s); candidates.set(e.to, arr); }
    for (const e of s.entry.fksIn) { const arr = candidates.get(e.from) ?? []; arr.push(s); candidates.set(e.from, arr); }
  }
  const present = new Set(prior.map((s) => s.entry).filter(Boolean));
  for (const [cand, srcs] of candidates) {
    const isDef = index.isDefaultSchema(cand.schema);
    // already joined tables (self/second joins) and other schemas rank lower
    const again = present.has(cand);
    const penalty = isDef ? 0 : 10;
    const name = formatObjectName(cand.schema, cand.name, isDef, fe);
    items.add({
      label: cand.name, kind: kindOfObject(cand.type), group: again ? 8 : 9, relevance: 20 - penalty, insertText: name, filterText: cand.name,
      detail: `FK → ${[...new Set(srcs.map((s) => s.label))].join(', ')}`, ref: objectRef(index, cand), usageKey: 'obj:' + cand.qualifiedName,
    });
    const alias = makeAlias(cand.name, taken, env.opts.aliasStyle);
    for (const s of new Set(srcs)) {
      for (const cond of fkConditions(cand, alias, s, env, fe)) {
        const text = `${name} ${alias} ${kwCase('ON', env.opts)} ${cond.text}`;
        items.add({
          label: `${cand.name} ${alias} ON ${cond.text}`, kind: 'snippet', group: again ? 8 : 10, relevance: 20 - penalty, insertText: text,
          filterText: cand.name, matchText: cand.name, detail: cond.fkName, documentation: '```sql\nJOIN ' + text + '\n```',
          usageKey: 'join:' + cand.qualifiedName,
        });
      }
    }
  }
}

function onConditionItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const j = c.afterJoinTable;
  if (!j) return;
  const fe = fenv(c, env);
  const jsrc = env.binder.source(j, c.scope);
  if (!jsrc.entry) {
    // MERGE ... USING s ON |: try same-name key columns between target and source
    return;
  }
  const others = env.binder.ownSources(c.scope).filter((s) => s.ref !== j && s.ref.range[0] < j.range[0]);
  for (const s of others) {
    for (const cond of fkConditions(jsrc.entry, jsrc.label, s, env, fe)) {
      items.add({ label: cond.text, kind: 'snippet', group: 11, relevance: 20, insertText: cond.text, filterText: cond.text, detail: cond.fkName, force: false });
    }
  }
  // MERGE target/source: when the source is unresolved there is no FK; offer `t.pk = s.pk`
  if (c.scope.kind === 'merge' && c.scope.targetTable) {
    const tgt = env.binder.target(c.scope);
    if (tgt?.entry && tgt.ref !== j) {
      for (const cond of fkConditions(tgt.entry, tgt.label, jsrc, env, fe)) items.add({ label: cond.text, kind: 'snippet', group: 11, insertText: cond.text, detail: cond.fkName });
    }
  }
}

// ------------------------------------------------------------ INSERT

function insertColumnItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const tgt = env.binder.target(c.scope);
  if (!tgt) return;
  const fe = fenv(c, env);
  const cols = tgt.columns();
  if (c.marker?.data?.conflict === 'columns') {
    // ON CONFLICT (|: the unique key columns (PK first)
    for (const col of cols) {
      items.add({ label: col.name, kind: 'column', group: 10, relevance: (col.isPk ? 50 : 10) + Math.max(0, 200 - col.ordinal) / 100, insertText: formatIdent(col.name, fe), filterText: col.name, detail: tgt.shortName, description: col.type, documentation: colDoc(col, tgt.display) });
    }
    return;
  }
  const already = new Set((c.scope.insertColumns ?? []).filter((p) => p.range[1] < c.prefixStart || p.range[0] > c.offset).map((p) => env.index.keyOf(p.text, p.quoted)));
  const ins = cols.filter((col) => insertable(col, cols, env.spec));
  if (ins.length && !c.prefixText && already.size === 0) {
    const text = ins.map((col) => formatIdent(col.name, fe, false)).join(', ');
    items.add({ label: text, kind: 'snippet', group: 11, insertText: text, detail: 'all insertable columns', filterText: text });
  }
  for (const col of cols) {
    if (already.has(env.index.keyOfCatalog(col.name))) continue;
    const isIns = insertable(col, cols, env.spec);
    if (!isIns && !c.prefixText) continue;
    items.add({
      label: col.name, kind: 'column', group: isIns ? 10 : 6, relevance: 10 + Math.max(0, 200 - col.ordinal), insertText: formatIdent(col.name, fe),
      filterText: col.name, detail: tgt.shortName, description: col.type + (col.identity ? ' identity' : ''), documentation: colDoc(col, tgt.display),
    });
  }
}

function valuesItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const { opts } = env;
  const tgt = env.binder.target(c.scope);
  if (tgt && !c.prefixText && c.prevToken?.text === '(') {
    const cols = tgt.columns();
    const named = c.scope.insertColumns?.length
      ? c.scope.insertColumns.map((p) => cols.find((x) => env.index.keyOfCatalog(x.name) === env.index.keyOf(p.text, p.quoted)) ?? { name: p.text, type: '', ordinal: 0, nullable: false })
      : cols.filter((col) => insertable(col, cols, env.spec));
    if (named.length) {
      const body = named.map((col, i) => `\${${i + 1}:${col.nullable ? kwCase('NULL', opts) : snippetEscape(col.name)}}`).join(', ');
      items.add({ label: named.map((x) => x.name).join(', '), kind: 'snippet', group: 11, insertText: body, isSnippet: true, detail: 'values for the column list', filterText: '(' });
    }
  }
  for (const k of ['NULL', 'DEFAULT']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 8 });
  functionItems(items, c, env, 6);
  variableItems(items, c, env, 7);
  sequenceItems(items, c, env, 6);
}

// ------------------------------------------------------------ EXEC

function execItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const { index, spec } = env;
  const fe = fenv(c, env);
  for (const e of index.defaultObjects()) {
    if (e.type !== 'proc' && !(spec.id === 'plsql' && (e.type === 'package' || e.type === 'func'))) continue;
    items.add({ label: e.name, kind: kindOfObject(e.type), group: 9, relevance: 10, insertText: formatObjectName(e.schema, e.name, true, fe) + (e.type === 'package' ? '.' : ''), command: e.type === 'package' ? 'retrigger' : undefined, ...(e.type === 'package' ? { detail: objectDetail(e.schema, e.type) } : { detail: `(${paramsText(e.params(), spec)})`, labelDetail: `(${paramsText(e.params(), spec)})`, description: objectDetail(e.schema, e.type) }), ref: objectRef(index, e), usageKey: 'obj:' + e.qualifiedName });
  }
  // schemas (default included) and T-SQL databases (`EXEC shop.dbo.p`), below the default schema's procedures
  containerItems(items, c, env, 6);
  for (const sc of index.schemas.values()) {
    if (index.isDefaultSchema(sc.name)) continue;
    for (const e of sc.objects) {
      if (e.type !== 'proc') continue;
      items.add({ label: `${sc.name}.${e.name}`, kind: 'procedure', group: 8, relevance: -10, matchText: e.name, insertText: formatIdent(sc.name, fe) + '.' + formatIdent(e.name, fe, false), detail: `(${paramsText(e.params(), spec)})`, labelDetail: `(${paramsText(e.params(), spec)})`, description: objectDetail(sc.name, e.type), ref: objectRef(index, e) });
    }
  }
  if (spec.id === 'tsql' && c.prefixText.toLowerCase().startsWith('sp')) {
    for (const p of ['sp_help', 'sp_helptext', 'sp_who2', 'sp_columns', 'sp_executesql', 'sp_rename', 'sp_spaceused', 'sp_lock', 'sp_configure', 'sp_tables']) items.add({ label: p, kind: 'procedure', group: 5, detail: 'system procedure' });
  }
}

function resolveRoutine(parts: NamePart[], env: CompleteEnv): { entry: ObjectEntry | null; member?: string } {
  const { index } = env;
  if (parts.length === 1) return { entry: index.resolve(parts, (e) => e.type === 'proc' || e.type === 'func' || e.type === 'tablefunc') };
  if (parts.length === 2) {
    const pkg = index.resolve([parts[0]], (e) => e.type === 'package');
    if (pkg) return { entry: pkg, member: parts[1].text };
    return { entry: index.resolve(parts, (e) => e.type === 'proc' || e.type === 'func' || e.type === 'tablefunc') };
  }
  if (parts.length === 3) {
    const pkg = index.resolve(parts.slice(0, 2), (e) => e.type === 'package');
    if (pkg) return { entry: pkg, member: parts[2].text };
  }
  return { entry: null };
}

/** Parameter lists of a routine or package member (one per overload). */
export function routineParams(parts: NamePart[], env: { index: CatalogIndex }): [string, string, string, number][][] {
  const r = resolveRoutine(parts, env as CompleteEnv);
  if (!r.entry) return [];
  if (r.member !== undefined) {
    const key = r.member.toUpperCase();
    return r.entry.members().filter((m) => m.n.toUpperCase() === key).map((m) => m.p);
  }
  // overloads (PostgreSQL): every routine with that name in the same schema
  const e0 = r.entry;
  const same = env.index.lookupIn(e0.schema, { text: e0.name, quoted: true }, true).filter((e) => e.type === 'proc' || e.type === 'func' || e.type === 'tablefunc');
  return same.length > 1 ? same.map((e) => e.params()) : [e0.params()];
}

function execArgItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const call = c.inFunctionCall;
  if (!call) return;
  if (env.spec.id === 'pgsql') {
    // CALL proc(…): an argument expression (named notation `p => v` comes from namedArgItems)
    variableItems(items, c, env, 7);
    functionItems(items, c, env, 5);
    for (const k of ['NULL', 'DEFAULT']) items.add({ label: kwCase(k, env.opts), kind: 'keyword', group: 4 });
    return;
  }
  const lists = routineParams(call.parts, env);
  const given = new Set(call.namedArgs.map((n) => n.toUpperCase()));
  for (const params of lists) {
    for (const p of params) {
      if (p[2] === 'return' || !p[0]) continue;
      if (given.has(p[0].toUpperCase())) continue;
      items.add({ label: `${p[0]} = `, kind: 'parameter', group: 10, relevance: 50 - params.indexOf(p), insertText: `${p[0]} = `, filterText: p[0], detail: `${p[1]}${p[2] !== 'in' ? ' ' + p[2].toUpperCase() : ''}${p[3] ? ' (optional)' : ''}`, command: 'retrigger' });
    }
  }
  variableItems(items, c, env, 7);
  functionItems(items, c, env, 4);
}

function namedArgItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const call = c.inFunctionCall!;
  if (call.exec || (env.spec.id !== 'plsql' && env.spec.id !== 'pgsql') || call.argName) return;
  const lists = routineParams(call.parts, env);
  const given = new Set(call.namedArgs.map((n) => n.toUpperCase()));
  for (const params of lists) {
    const real = params.filter((p) => p[2] !== 'return' && p[0]);
    for (let i = call.argIndex; i < real.length; i++) {
      const p = real[i];
      if (given.has(p[0].toUpperCase())) continue;
      items.add({ label: `${p[0].toLowerCase()} =>`, kind: 'parameter', group: 9, relevance: 40 - (i - call.argIndex), insertText: `${p[0].toLowerCase()} => `, filterText: p[0], detail: `${p[2].toUpperCase()} ${p[1]}`.trim() });
    }
  }
}

// ------------------------------------------------------------ functions / variables / packages

function functionItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const { spec, opts, index } = env;
  const fe = fenv(c, env);
  const fromLike = c.clause === 'from' || c.clause === 'join';
  for (const f of spec.functions) {
    if (f.kind === 'table' && !fromLike && spec.id !== 'pgsql') continue;
    if (f.kind === 'global') continue; // offered after '@'
    // Case-sensitive dialects (ClickHouse `toYYYYMM`, `arrayJoin`) keep the spelling of the catalog
    const name = (spec.id === 'sqlite' && opts.keywordCase === 'asIs') || spec.preserveNameCase ? f.name : kwCase(f.name, opts);
    const noParens = f.kind === 'niladic';
    items.add({
      label: name, kind: 'function', group, relevance: -1, insertText: noParens ? name : name + '($0)', isSnippet: !noParens,
      command: noParens ? undefined : 'signatureHelp', detail: funcSignatureText(f), documentation: functionDoc(f), filterText: name,
      usageKey: 'fn:' + f.name.toUpperCase(), deprecated: f.deprecated,
    });
  }
  // user scalar functions (T-SQL requires the schema prefix)
  const seenFn = new Set<string>();
  for (const e of index.defaultObjects()) {
    if (e.type !== 'func' && !(spec.id === 'pgsql' && e.type === 'tablefunc' && !fromLike)) continue;
    // PostgreSQL overloads: one item per name (signature help lists every overload)
    if (spec.id === 'pgsql') { if (seenFn.has(e.schema + '.' + e.name)) continue; seenFn.add(e.schema + '.' + e.name); }
    const insertName = spec.id === 'tsql' ? formatIdent(e.schema, fe) + '.' + formatIdent(e.name, fe, false) : formatObjectName(e.schema, e.name, true, fe);
    items.add({ label: e.name, kind: 'function', group, relevance: 5, insertText: insertName + '($0)', isSnippet: true, command: 'signatureHelp', detail: `(${paramsText(e.params(), spec)})`, labelDetail: `(${paramsText(e.params(), spec)})`, description: objectDetail(e.schema, e.type), filterText: e.name, ref: objectRef(index, e), usageKey: 'obj:' + e.qualifiedName });
  }
}

function globalVarItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  if (!c.prefix.startsWith('@')) return;
  for (const f of env.spec.functions) {
    if (f.kind !== 'global') continue;
    items.add({ label: f.name, kind: 'variable', group: c.prefix.startsWith('@@') ? 10 : 6, insertText: f.name, detail: f.returns ?? 'global variable', documentation: f.doc, filterText: f.name, matchText: f.name });
  }
}

function variableItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  for (const v of env.binder.variables(c.scope)) {
    if (v.kind === 'exception') continue;
    const label = v.name;
    items.add({ label, kind: v.kind === 'param' ? 'parameter' : 'variable', group, insertText: v.name, filterText: v.name, detail: v.type || v.kind, documentation: varDoc(v) });
  }
}

export function varDoc(v: VarDef): string {
  const what = v.kind === 'param' ? 'parameter' : v.kind === 'cursor' ? 'cursor' : v.kind === 'tableVar' ? 'table variable' : v.kind === 'record' ? 'record' : 'variable';
  let s = `${what} \`${v.name}\`${v.type ? ' ' + v.type : ''}`;
  if (v.rowtypeOf) s += `\n\nrow of ${v.rowtypeOf.map((p) => p.text).join('.')}`;
  if (v.columns?.length) s += '\n\n' + v.columns.map((x) => `${x.name} ${x.type}`).join(', ');
  return s;
}

function packageItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  if (env.spec.id !== 'plsql') return;
  const fe = fenv(c, env);
  for (const e of env.index.defaultObjects()) {
    if (e.type !== 'package') continue;
    items.add({ label: e.name, kind: 'package', group, insertText: formatIdent(e.name, fe) + '.', command: 'retrigger', detail: 'package', ref: objectRef(env.index, e) });
  }
  for (const e of env.index.builtinPackages()) {
    items.add({ label: e.name, kind: 'package', group: group - 1, insertText: formatIdent(e.name, fe) + '.', command: 'retrigger', detail: 'SYS package', documentation: e.obj.cm ?? undefined });
  }
}

function sequenceItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  if (env.spec.id === 'sqlite' || !c.prefixText) return;
  const fe = fenv(c, env);
  for (const e of env.index.defaultObjects()) {
    if (e.type !== 'sequence') continue;
    items.add({ label: e.name, kind: 'sequence', group, insertText: formatIdent(e.name, fe) + '.', command: 'retrigger', detail: 'sequence', ref: objectRef(env.index, e) });
  }
}

function dataTypeItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const { spec, opts } = env;
  for (const t of spec.dataTypes) {
    const label = spec.preserveNameCase || ((spec.id === 'tsql' || spec.id === 'pgsql') && opts.keywordCase !== 'upper') ? t : kwCase(t, opts);
    items.add({ label, kind: 'type', group, insertText: label, detail: 'data type' });
  }
  void c;
}

// ------------------------------------------------------------ DDL

function ddlItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const d = c.marker?.data?.ddl;
  if (!d) return;
  const { index } = env;
  const fe = fenv(c, env);
  switch (d.what) {
    case 'dataType': dataTypeItems(items, c, env, 9); if (env.spec.id === 'pgsql') userTypeItems(items, c, env, 8); return;
    case 'newName': case 'columnName': return;
    case 'columnOf': {
      if (!d.table) return;
      const e = index.resolve(d.table.parts, (x) => x.isTabular);
      for (const col of e?.columns() ?? []) items.add({ label: col.name, kind: 'column', group: 9, relevance: Math.max(0, 200 - col.ordinal), insertText: formatIdent(col.name, fe), description: col.type, detail: e!.name });
      return;
    }
    case 'objectName': {
      const want = (d.objectType ?? 'ANY').toUpperCase();
      const typeOk = (e: ObjectEntry) => {
        switch (want) {
          case 'TABLE': return e.type === 'table';
          case 'VIEW': return e.type === 'view';
          case 'MATERIALIZED': return e.type === 'mview';
          case 'PROC': case 'PROCEDURE': return e.type === 'proc';
          case 'FUNCTION': return e.type === 'func' || e.type === 'tablefunc';
          case 'PACKAGE': return e.type === 'package';
          case 'SEQUENCE': return e.type === 'sequence';
          case 'SYNONYM': return e.type === 'synonym';
          case 'TRIGGER': return e.type === 'trigger';
          case 'TYPE': case 'DOMAIN': return e.type === 'type';
          case 'INDEX': case 'SCHEMA': case 'USER': case 'DATABASE': return false;
          default: return true;
        }
      };
      for (const sc of index.schemas.values()) {
        const isDef = index.isDefaultSchema(sc.name);
        for (const e of sc.objects) {
          if (!typeOk(e)) continue;
          items.add({ label: isDef ? e.name : `${sc.name}.${e.name}`, kind: kindOfObject(e.type), group: isDef ? 9 : 7, matchText: e.name, insertText: formatObjectName(sc.name, e.name, isDef, fe), detail: objectDetail(sc.name, e.type), ref: objectRef(index, e) });
        }
      }
      // schemas only (CREATE / ALTER of a routine or view cannot name another database)
      containerItems(items, c, env, 6, { databases: false });
      if (want === 'TABLE') tempTableItems(items, c, env, 8);
      return;
    }
  }
}

// ------------------------------------------------------------ qualifier

function qualifierItems(items: Items, c: CursorContext, env: CompleteEnv): boolean {
  const { index, spec, binder, opts } = env;
  const q = c.qualifier!;
  const fe: FormatEnv = { ...fenv(c, env) };
  const t = binder.resolveQualifier(q, c.scope);
  const tableClause = ['from', 'join', 'update', 'delete', 'into', 'using'].includes(c.clause) || (c.clause === 'ddl' && c.marker?.data?.ddl?.what === 'objectName');
  if (!t) {
    // unknown: maybe a schema that is not loaded yet
    if (q.length === 1 && !binder.findSourceByLabel(q[0], c.scope)) {
      index.requestSchema(q[0].text);
      if (index.isUnloadedSchema(q[0].text, q[0].quoted)) loadingItem(items, c, q[0].text);
    }
    return true;
  }
  switch (t.kind) {
    case 'source': case 'record': case 'object': {
      const cols = t.kind === 'source' ? t.src.columns() : t.kind === 'record' ? t.columns : t.entry.columns();
      const owner = t.kind === 'source' ? t.src.display : t.kind === 'record' ? t.name : t.entry.qualifiedName;
      const shortName = t.kind === 'source' ? t.src.shortName : t.kind === 'record' ? t.name : t.entry.name;
      const setLhs = c.clause === 'set' && c.setLhs;
      for (const col of cols) {
        if (col.hidden && !c.prefixText) continue;
        if (setLhs && (col.identity || col.computed)) continue;
        items.add({
          label: col.name, kind: 'column', group: 9, relevance: Math.max(0, 300 - col.ordinal) / 3, insertText: formatIdent(col.name, fe, false),
          filterText: col.name, detail: shortName, description: col.type, documentation: colDoc(col, owner), usageKey: `col:${shortName}.${col.name}`,
        });
      }
      if ((c.clause === 'select' || c.clause === 'returning') && !c.prefixText && t.kind !== 'record') items.add({ label: '*', kind: 'operator', group: 8, insertText: '*', detail: 'all columns' });
      return false;
    }
    case 'schema': {
      const sc: SchemaEntry | null = t.schema;
      if (!sc) {
        // another database's schema: its catalog is not loaded here (nothing to offer, no empty box: auto-triggered)
        const local = !t.database || (!!index.database && index.keyOfCatalog(t.database) === index.keyOfCatalog(index.database));
        if (!local) return true;
        index.requestSchema(t.name);
        if (index.isUnloadedSchema(t.name, true) || !t.database) loadingItem(items, c, t.name);
        return true;
      }
      const inExec = c.clause === 'exec';
      const inCast = c.clause === 'cast' || (c.clause === 'ddl' && c.marker?.data?.ddl?.what === 'dataType');
      for (const e of sc.objects) {
        let group = 0;
        if (inCast) group = e.type === 'type' ? 9 : 0;
        else if (inExec) group = e.type === 'proc' ? 9 : e.type === 'package' ? 8 : 0;
        else if (tableClause) group = e.isTabular ? 9 : e.type === 'synonym' ? 8 : (e.type === 'package' || e.type === 'sequence') && spec.id === 'plsql' ? 5 : 0;
        else group = e.type === 'func' ? 9 : e.type === 'sequence' || e.type === 'package' ? 8 : e.isTabular || e.type === 'synonym' ? 6 : e.type === 'proc' ? 4 : 0;
        if (!group) continue;
        const isCallable = e.type === 'func' && !tableClause;
        const isContainer = e.type === 'package' || e.type === 'sequence';
        const name = formatIdent(e.name, fe, false);
        items.add({
          label: e.name, kind: kindOfObject(e.type), group, insertText: isCallable ? name + '($0)' : isContainer && !tableClause ? name + '.' : name,
          isSnippet: isCallable, command: isCallable ? 'signatureHelp' : isContainer && !tableClause ? 'retrigger' : undefined, filterText: e.name,
          detail: e.type === 'func' || e.type === 'proc' || e.type === 'tablefunc' ? `(${paramsText(e.params(), spec)})` : objectTypeLabel(e.type),
          documentation: e.obj.cm ?? undefined, ref: objectRef(index, e), usageKey: 'obj:' + e.qualifiedName,
        });
      }
      return false;
    }
    case 'database': {
      if (index.database && t.name.toUpperCase() === index.database.toUpperCase()) {
        for (const sc of index.schemas.values()) items.add({ label: sc.name, kind: 'schema', group: 9, insertText: formatIdent(sc.name, fe, false) + '.', command: 'retrigger', detail: 'schema' });
        for (const name of index.unloadedSchemaNames()) items.add({ label: name, kind: 'schema', group: 9, insertText: formatIdent(name, fe, false) + '.', command: 'retrigger', detail: 'schema' });
      }
      return true;
    }
    case 'package': {
      const byName = new Map<string, number>();
      for (const m of t.entry.members()) byName.set(m.n, (byName.get(m.n) ?? 0) + 1);
      for (const m of t.entry.members()) {
        const params = m.p.filter((p) => p[2] !== 'return');
        const ret = m.p.find((p) => p[2] === 'return');
        const sig = `(${paramsText(m.p, spec)})${ret ? ' RETURN ' + ret[1] : ''}`;
        const name = spec.id === 'plsql' && opts.identifierCase === 'lower' ? m.n.toLowerCase() : m.n;
        items.add({
          label: m.n, kind: m.k === 'func' ? 'function' : 'procedure', group: 9, insertText: params.length ? name + '($0)' : name, isSnippet: params.length > 0,
          command: params.length ? 'signatureHelp' : undefined, detail: sig, filterText: m.n,
          documentation: `${t.entry.name}.${m.n}${sig}${(byName.get(m.n) ?? 0) > 1 ? `\n\noverload ${m.ov} of ${byName.get(m.n)}` : ''}`,
        });
      }
      return false;
    }
    case 'sequence': {
      for (const k of ['NEXTVAL', 'CURRVAL']) items.add({ label: kwCase(k, opts), kind: 'keyword', group: 9, detail: `${t.entry.name} sequence`, filterText: k });
      return false;
    }
  }
  return false;
}

export type { VisibleSource, TableRef };

// ------------------------------------------------------------ PostgreSQL

/** Catalog types (enums, domains, composites): unqualified on the search_path, qualified elsewhere. */
function userTypeItems(items: Items, c: CursorContext, env: CompleteEnv, group: number): void {
  const { index } = env;
  const fe = fenv(c, env);
  for (const sc of index.schemas.values()) {
    const isDef = index.isDefaultSchema(sc.name);
    for (const e of sc.objects) {
      if (e.type !== 'type') continue;
      items.add({
        label: isDef ? e.name : `${sc.name}.${e.name}`, kind: 'type', group: isDef ? group : group - 1, matchText: e.name,
        insertText: formatObjectName(sc.name, e.name, isDef, fe), detail: typeDetail(e), documentation: e.obj.cm ?? undefined,
        ref: objectRef(index, e), usageKey: 'obj:' + e.qualifiedName,
      });
    }
  }
}

/** `enum: a, b, c` / `domain over text` / `composite type`. */
export function typeDetail(e: ObjectEntry): string {
  const cols = e.obj.c ?? [];
  if (cols.length && cols.every((x) => x[1] === 'enum label')) return 'enum: ' + cols.map((x) => x[0]).join(', ');
  const cm = e.obj.cm ?? '';
  const dm = /^domain over (.+?)(?:\.|\s*$|\n)/i.exec(cm);
  if (dm) return 'domain over ' + dm[1];
  return cols.length ? 'composite type' : 'type';
}

/** `expr::|` / `CAST(expr AS |`: built-in data types and the catalog's types. */
function castItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const commit = [' ', ')', ','];
  const before = items.list.length;
  dataTypeItems(items, c, env, 9);
  userTypeItems(items, c, env, 8);
  for (let i = before; i < items.list.length; i++) items.list[i].commitCharacters = commit;
}

/** `EXCLUDED.<col>` items on the right side of `ON CONFLICT … DO UPDATE SET col = |` (the assigned column first). */
function excludedItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  const ins = env.binder.insertScope(c.scope);
  const tgt = ins ? env.binder.target(ins) : null;
  if (!tgt) return;
  const fe = fenv(c, env);
  // the column being assigned: `name = |`
  const toks = c.statement.tokens;
  let lhs: string | null = null;
  const pi = c.prevToken ? toks.indexOf(c.prevToken) : -1;
  if (pi > 0 && c.prevToken!.kind === 'op' && c.prevToken!.text === '=') {
    const nt = toks[pi - 1];
    if (nt && (nt.kind === 'ident' || nt.kind === 'quotedIdent' || nt.kind === 'keyword')) lhs = env.index.keyOf(nt.kind === 'quotedIdent' ? nt.text.slice(1, -1) : nt.text, nt.kind === 'quotedIdent');
  }
  const ex = kwCase('EXCLUDED', env.opts);
  for (const col of tgt.columns()) {
    const isLhs = lhs !== null && env.index.keyOfCatalog(col.name) === lhs;
    items.add({
      label: `${ex}.${col.name}`, kind: 'column', group: 10, relevance: (isLhs ? 60 : 10) + Math.max(0, 200 - col.ordinal) / 100,
      insertText: `${ex}.${formatIdent(col.name, fe, false)}`, filterText: col.name, matchText: col.name, detail: 'excluded row', description: col.type,
      documentation: colDoc(col, tgt.display),
    });
  }
}

const JSON_OPS = ['->', '->>', '#>', '#>>', '@>', '<@', '?', '?|', '?&', '||', '-', '#-', '@?', '@@'];

/** After a json/jsonb operand: the JSON operators with their docs. */
function jsonOperatorItems(items: Items, c: CursorContext, env: CompleteEnv): void {
  if (c.prefixText || !c.prevToken) return;
  const p = c.prevToken;
  if (p.kind !== 'ident' && p.kind !== 'quotedIdent') return;
  // the column behind the operand (`meta` or `x.meta`)
  const toks = c.statement.tokens;
  const i = toks.indexOf(p);
  const name = { text: p.kind === 'quotedIdent' ? p.text.slice(1, -1) : p.text, quoted: p.kind === 'quotedIdent' };
  let type = '';
  const key = env.index.keyOf(name.text, name.quoted);
  if (i >= 2 && toks[i - 1].kind === 'punct' && toks[i - 1].text === '.') {
    const qt = toks[i - 2];
    const target = env.binder.resolveQualifier([{ text: qt.text, quoted: qt.kind === 'quotedIdent', range: [qt.start, qt.end] }], c.scope);
    const cols = target ? env.binder.qualifierColumns(target, c.scope) : null;
    type = cols?.find((x) => env.index.keyOfCatalog(x.name) === key)?.type ?? '';
  } else {
    for (const v of env.binder.visibleSources(c.scope)) {
      const col = v.src.columns().find((x) => env.index.keyOfCatalog(x.name) === key);
      if (col) { type = col.type; break; }
    }
  }
  if (!/json/i.test(type)) return;
  JSON_OPS.forEach((op, k) => {
    const def = env.spec.operators.find((o) => o.op === op);
    items.add({ label: op, kind: 'operator', group: 10, relevance: 20 - k, insertText: op + ' ', filterText: op, detail: `${type} operator`, documentation: def?.doc, force: true });
  });
}
