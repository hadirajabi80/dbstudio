// Pure logic of the logs view: source merging, level/time/search filters, the tail buffer, export formatting and the
// activity summaries (docs/PLAN-M2.md 8.2). No React, no stores: everything here is unit-tested directly.
import type { ActivityRow, LogEntry, LogExportFormat, LogLevel, LogSourceInfo } from '../../api/types';
import { ENGINE_LOG_CID } from '../../api/client.m2';
import type { ActivityMode, FromPreset, LevelChip } from './open';

// ---------------------------------------------------------------- sources

/** SQL Server error/agent log files (`sp_enumerrorlogs`; index 0 = current). Engine extension of LogSourceInfo. */
export interface LogArchiveInfo { index: number; date: string | null; sizeBytes: number }
export type LogSourceInfoEx = LogSourceInfo & { archives?: LogArchiveInfo[] };

/** A selectable log source and the connection id its queries/streams use (`engine` for the engine log). */
export interface UiSource {
  info: LogSourceInfoEx;
  cid: string;
}

export const ENGINE_SOURCE_ID = 'engine';

/** Used when `GET /logs/engine/sources` fails: the engine log is always offered. */
export const ENGINE_SOURCE_FALLBACK: LogSourceInfoEx = {
  id: ENGINE_SOURCE_ID, title: 'Engine log', kind: 'log', supportsTail: true, supportsRange: true,
  levels: ['debug', 'info', 'warn', 'error', 'fatal'], available: true,
};

export interface MergedSources {
  logs: UiSource[];
  /** The connection's `kind: 'activity'` entry (drives the Activity sub-view), null when there is none. */
  activity: LogSourceInfoEx | null;
}

/**
 * The view's source list: the connection's log sources (non-activity), then the engine log (always, queried under
 * cid `engine`). For the engine tab (or SQLite, which has no sources) only the engine log remains.
 */
export function mergeSources(cid: string, connSources: readonly LogSourceInfoEx[] | null, engineSources: readonly LogSourceInfoEx[] | null): MergedSources {
  const own = cid === ENGINE_LOG_CID ? [] : connSources ?? [];
  const logs: UiSource[] = own.filter((s) => s.kind !== 'activity' && s.id !== ENGINE_SOURCE_ID).map((info) => ({ info, cid }));
  const engine = (engineSources ?? []).filter((s) => s.kind !== 'activity');
  const eng = engine.length ? engine : [ENGINE_SOURCE_FALLBACK];
  for (const info of eng) logs.push({ info, cid: ENGINE_LOG_CID });
  const activity = cid === ENGINE_LOG_CID ? null : own.find((s) => s.kind === 'activity') ?? null;
  return { logs, activity };
}

/** Archive choices of a SQL Server error/agent log ("Current", "Archive #1"…). */
export function archiveOptions(src: LogSourceInfoEx | null | undefined): { value: number; label: string }[] {
  if (!src || (src.id !== 'errorlog' && src.id !== 'agentlog')) return [];
  if (src.archives?.length) {
    return [...src.archives].sort((a, b) => a.index - b.index).map((a) => ({
      value: a.index,
      label: a.index === 0 ? 'Current' : `Archive #${a.index}${a.date ? ` (${shortDate(a.date)})` : ''}`,
    }));
  }
  return Array.from({ length: 7 }, (_, i) => ({ value: i, label: i === 0 ? 'Current' : `Archive #${i}` }));
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** `CONFIG SET name value` of a Redis hint → the setter body (null for anything else). */
export function parseConfigSet(needs: string | null | undefined): { name: string; value: string } | null {
  const m = /^\s*CONFIG\s+SET\s+(\S+)\s+(\S+)\s*;?\s*$/i.exec(needs ?? '');
  return m ? { name: m[1], value: m[2] } : null;
}

/**
 * The MongoDB "Profiler — db" source while profiling is off: its hint is `db.getSiblingDB("shop").setProfilingLevel(1,
 * { slowms: 100 })`, which the view can apply (`api.mongo.setProfiling`) instead of only copying it.
 */
export function parseProfilingHint(sourceId: string | null | undefined, needs: string | null | undefined): { db: string; level: 1 | 2; slowms: number } | null {
  if (!sourceId?.startsWith('profiler:') || !needs) return null;
  const m = /setProfilingLevel\(\s*([12])\s*(?:,\s*\{[^}]*?slowms\s*:\s*(\d+)[^}]*\})?\s*\)/.exec(needs);
  if (!m) return null;
  const db = sourceId.slice('profiler:'.length);
  return db ? { db, level: m[1] === '2' ? 2 : 1, slowms: m[2] ? Number(m[2]) : 100 } : null;
}

// ---------------------------------------------------------------- levels and time

/** Server-side levels of the selected chips: `fatal` rides with `error`, `unknown` is always included. */
export function expandLevels(chips: readonly LevelChip[]): LogLevel[] {
  const out: LogLevel[] = [];
  for (const c of chips) {
    out.push(c);
    if (c === 'error') out.push('fatal');
  }
  out.push('unknown');
  return out;
}

export function chipOf(level: LogLevel): LevelChip | null {
  if (level === 'fatal') return 'error';
  if (level === 'unknown') return null;
  return level;
}

export function levelVisible(level: LogLevel, chips: readonly LevelChip[]): boolean {
  const c = chipOf(level);
  return c === null || chips.includes(c);
}

export const PRESET_MS: Record<Exclude<FromPreset, 'custom'>, number> = {
  '15m': 15 * 60_000, '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000,
};

export const PRESET_LABELS: Record<FromPreset, string> = { '15m': 'Last 15 min', '1h': 'Last 1 h', '24h': 'Last 24 h', '7d': 'Last 7 days', custom: 'Custom…' };

/** ISO `from`/`to` of a preset at `now` (custom: the stored values; `to` null = now, i.e. omitted). */
export function timeRange(preset: FromPreset, now: number, fromCustom: string | null, to: string | null): { from?: string; to?: string } {
  const toIso = to && !Number.isNaN(Date.parse(to)) ? new Date(to).toISOString() : undefined;
  if (preset === 'custom') {
    const from = fromCustom && !Number.isNaN(Date.parse(fromCustom)) ? new Date(fromCustom).toISOString() : undefined;
    return { from, to: toIso };
  }
  return { from: new Date(now - PRESET_MS[preset]).toISOString(), to: toIso };
}

/** `<input type="datetime-local">` value of an ISO time (local), and back. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- search

export interface Matcher {
  /** Empty search: matches everything, highlights nothing. */
  empty: boolean;
  /** The search is a valid regular expression with metacharacters (else a literal substring). */
  regex: boolean;
  test(text: string): boolean;
  /** Global, case-insensitive pattern for highlighting (null when empty). */
  pattern: RegExp | null;
}

const META = /[.*+?^${}()|[\]\\]/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive search: a regular expression when the text is one, else a literal substring (regex fallback). */
export function makeMatcher(q: string): Matcher {
  const s = q.trim();
  if (!s) return { empty: true, regex: false, test: () => true, pattern: null };
  let src = escapeRe(s);
  let regex = false;
  if (META.test(s)) {
    try {
      const re = new RegExp(s, 'i');
      // A pattern that matches the empty string ("a*") would highlight nothing useful: treat it literally.
      if (!re.test('')) {
        src = s;
        regex = true;
      }
    } catch {
      // invalid regex: literal
    }
  }
  const one = new RegExp(src, 'i');
  return { empty: false, regex, test: (t) => one.test(t), pattern: new RegExp(src, 'gi') };
}

/** The `q` sent to the server (substring search): only plain text; a regex is applied client-side. */
export function serverQuery(q: string): string | undefined {
  const s = q.trim();
  return s && !META.test(s) ? s : undefined;
}

export interface Segment { text: string; hit: boolean }

/** Splits `text` into highlighted / plain segments. */
export function highlight(text: string, pattern: RegExp | null): Segment[] {
  if (!pattern || !text) return [{ text, hit: false }];
  const out: Segment[] = [];
  const re = new RegExp(pattern.source, 'gi');
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (!m[0]) continue;
    if (i > last) out.push({ text: text.slice(last, i), hit: false });
    out.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length ? out : [{ text, hit: false }];
}

export function entryMatches(e: LogEntry, chips: readonly LevelChip[], m: Matcher): boolean {
  if (!levelVisible(e.level, chips)) return false;
  if (m.empty) return true;
  return m.test(e.message) || m.test(e.source) || (!!e.detail && m.test(e.detail));
}

// ---------------------------------------------------------------- tail buffer

export const TAIL_CAP = 20_000;

/**
 * The entries of the view (ascending `seq`): query results plus tail items, capped at `cap` (oldest evicted and
 * counted). Duplicate `seq`s (a tail item already returned by the initial query) are skipped.
 */
export class TailBuffer {
  readonly cap: number;
  entries: LogEntry[] = [];
  evicted = 0;
  private seqs = new Set<number>();

  constructor(cap = TAIL_CAP) {
    this.cap = cap;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Replace everything (a fresh query); keeps the eviction counter unless `resetCounters`. */
  replace(entries: readonly LogEntry[], resetCounters = true): void {
    this.entries = entries.length > this.cap ? entries.slice(entries.length - this.cap) : [...entries];
    this.seqs = new Set(this.entries.map((e) => e.seq));
    if (resetCounters) this.evicted = 0;
  }

  /** Appends newer entries; returns how many old ones were evicted. */
  push(items: readonly LogEntry[]): number {
    let added = 0;
    for (const e of items) {
      if (this.seqs.has(e.seq)) continue;
      this.seqs.add(e.seq);
      this.entries.push(e);
      added++;
    }
    if (!added) return 0;
    const over = this.entries.length - this.cap;
    if (over <= 0) return 0;
    const gone = this.entries.splice(0, over);
    for (const e of gone) this.seqs.delete(e.seq);
    this.evicted += over;
    return over;
  }

  /** Prepends older entries ("Load older"); only as many as fit under the cap. Returns how many were taken. */
  prepend(older: readonly LogEntry[]): number {
    const fresh = older.filter((e) => !this.seqs.has(e.seq));
    const room = Math.max(0, this.cap - this.entries.length);
    const take = fresh.slice(Math.max(0, fresh.length - room));
    for (const e of take) this.seqs.add(e.seq);
    this.entries = [...take, ...this.entries];
    return take.length;
  }

  clear(): void {
    this.entries = [];
    this.seqs.clear();
    this.evicted = 0;
  }

  oldestSeq(): number | null {
    return this.entries.length ? this.entries[0].seq : null;
  }
}

// ---------------------------------------------------------------- formatting

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** HH:mm:ss.SSS (local time); '—' for entries without a timestamp. */
export function formatTime(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function fullTime(ts: string | null): string {
  if (!ts) return 'No timestamp';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

export const LEVEL_LABEL: Record<LogLevel, string> = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', fatal: 'FATAL', unknown: '—' };

/** One entry as text (Copy / txt export): `ISO LEVEL [source] message`, then the detail and the fields indented. */
export function entryText(e: LogEntry): string {
  const head = `${e.ts ?? '-'} ${LEVEL_LABEL[e.level].padEnd(5)} [${e.source}] ${e.message}`;
  const lines = [head];
  if (e.detail) lines.push(...e.detail.split(/\r?\n/).map((l) => `    ${l}`));
  for (const [k, v] of Object.entries(e.fields ?? {})) lines.push(`    ${k}: ${v}`);
  return lines.join('\n');
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const EXPORT_MIME: Record<LogExportFormat, string> = { txt: 'text/plain', csv: 'text/csv', json: 'application/json' };

/** Client-side export of entries (the tail buffer). CSV: RFC 4180, fields as one JSON column. */
export function formatEntries(entries: readonly LogEntry[], format: LogExportFormat): string {
  if (format === 'json') {
    return JSON.stringify(entries.map((e) => ({ ts: e.ts, level: e.level, source: e.source, message: e.message, detail: e.detail ?? null, fields: e.fields ?? {}, seq: e.seq })), null, 2);
  }
  if (format === 'csv') {
    const rows = ['ts,level,source,message,detail,fields'];
    for (const e of entries) {
      rows.push([e.ts ?? '', e.level, e.source, e.message, e.detail ?? '', e.fields && Object.keys(e.fields).length ? JSON.stringify(e.fields) : ''].map(csvCell).join(','));
    }
    return `${rows.join('\r\n')}\r\n`;
  }
  return `${entries.map(entryText).join('\n')}\n`;
}

export function exportFileName(sourceId: string, format: LogExportFormat, now = new Date()): string {
  // Same pattern as the engine's Content-Disposition: logs-<source>-<yyyyMMdd-HHmmss>.<ext>
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `logs-${sourceId.replace(/[^\w.-]+/g, '_')}-${stamp}.${format}`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

// ---------------------------------------------------------------- activity

const IDLE = /^(idle|sleeping|inactive|dormant|background)\b|idle in transaction \(aborted\)/i;

/** Sessions that do nothing right now (sleeping SQL Server spids, idle PG backends, idle Redis clients). */
export function isIdle(r: ActivityRow): boolean {
  if (r.kind === 'lock') return false;
  return IDLE.test(r.state.trim()) || r.state.trim() === '';
}

export interface ActivitySummary {
  sessions: number;
  running: number;
  blocked: number;
  /** Longest running non-idle row. */
  longest: ActivityRow | null;
}

export function activitySummary(rows: readonly ActivityRow[]): ActivitySummary {
  let running = 0;
  let blocked = 0;
  let longest: ActivityRow | null = null;
  let sessions = 0;
  for (const r of rows) {
    if (r.kind === 'lock') continue;
    sessions++;
    if (r.blockedBy) blocked++;
    if (isIdle(r)) continue;
    running++;
    if ((r.durationMs ?? -1) > (longest?.durationMs ?? -1)) longest = r;
  }
  return { sessions, running, blocked, longest };
}

/** Ids that block another row; `head` = blockers that are not blocked themselves (the root of a chain). */
export function blockers(rows: readonly ActivityRow[]): { all: Set<string>; head: Set<string> } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const all = new Set<string>();
  for (const r of rows) if (r.blockedBy && r.kind !== 'lock') all.add(r.blockedBy);
  const head = new Set<string>();
  for (const id of all) if (!byId.get(id)?.blockedBy) head.add(id);
  return { all, head };
}

/** Chain from `id` up to its head blocker ("61 ← 57"); stops on cycles. */
export function blockingChain(rows: readonly ActivityRow[], id: string): string[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: string[] = [];
  let cur = byId.get(id)?.blockedBy;
  while (cur && !out.includes(cur) && cur !== id) {
    out.push(cur);
    cur = byId.get(cur)?.blockedBy;
  }
  return out;
}

export interface ActivityFilter {
  mode: ActivityMode;
  onlyActive: boolean;
  search: string;
}

function rowText(r: ActivityRow): string {
  return [r.id, r.user, r.host, r.app, r.database, r.state, r.waitType, r.command, r.text, r.blockedBy, ...Object.values(r.fields ?? {})].filter(Boolean).join('\u0001');
}

export function filterActivity(rows: readonly ActivityRow[], f: ActivityFilter): ActivityRow[] {
  const m = makeMatcher(f.search);
  // An idle session that blocks others (open transaction holding locks) is the interesting one: always kept.
  const blocking = f.onlyActive ? blockers(rows).all : null;
  return rows.filter((r) => {
    if (f.mode === 'locks' ? r.kind !== 'lock' : r.kind === 'lock') return false;
    if (blocking && f.mode === 'sessions' && isIdle(r) && !r.blockedBy && !blocking.has(r.id)) return false;
    return m.empty || m.test(rowText(r));
  });
}

export type ActivityColumnKey =
  | 'id' | 'user' | 'host' | 'app' | 'database' | 'state' | 'duration' | 'wait' | 'blockedBy' | 'command' | 'text' | 'cpu' | 'reads'
  | 'resource' | 'mode' | 'count';

export interface ActivityColumn { key: ActivityColumnKey; title: string; width: number; numeric?: boolean }

const ID_TITLE: Record<string, string> = { sqlserver: 'SPID', oracle: 'SID', postgresql: 'PID', redis: 'Client', mongodb: 'opid', kafka: 'Id' };
const HOST_TITLE: Record<string, string> = { redis: 'Address', mongodb: 'Client', postgresql: 'Client' };
const DB_TITLE: Record<string, string> = { redis: 'DB', mongodb: 'Namespace', oracle: 'Schema' };

export function cellValue(r: ActivityRow, k: ActivityColumnKey): string {
  switch (k) {
    case 'duration':
      return r.durationMs != null ? formatDuration(r.durationMs) : r.since ? formatTime(r.since) : '';
    case 'wait':
      return r.waitType ?? r.fields?.wait ?? '';
    case 'cpu':
      return r.cpu != null ? fmtCount(r.cpu) : '';
    case 'reads':
      return r.reads != null ? fmtCount(r.reads) : '';
    case 'resource':
    case 'mode':
    case 'count':
      return r.fields?.[k] ?? '';
    case 'blockedBy':
      return r.blockedBy ?? '';
    default:
      return (r[k as 'id'] as string | undefined) ?? '';
  }
}

/** Columns for the rows at hand: id and state always, the others when some row has a value (columns per provider). */
export function activityColumns(rows: readonly ActivityRow[], providerId: string | undefined, mode: ActivityMode): ActivityColumn[] {
  const p = providerId ?? '';
  const all: ActivityColumn[] = mode === 'locks'
    ? [
      { key: 'id', title: 'Lock', width: 150 }, { key: 'resource', title: 'Resource', width: 220 }, { key: 'mode', title: 'Mode', width: 80 },
      { key: 'state', title: 'State', width: 80 }, { key: 'count', title: 'Count', width: 70, numeric: true }, { key: 'blockedBy', title: 'Blocked by', width: 110 },
      { key: 'database', title: DB_TITLE[p] ?? 'Database', width: 120 },
    ]
    : [
      { key: 'id', title: ID_TITLE[p] ?? 'Id', width: p === 'oracle' ? 110 : 80 }, { key: 'user', title: 'User', width: 110 },
      { key: 'host', title: HOST_TITLE[p] ?? 'Host', width: 130 }, { key: 'app', title: 'Application', width: 140 },
      { key: 'database', title: DB_TITLE[p] ?? 'Database', width: 110 }, { key: 'state', title: 'State', width: 100 },
      { key: 'duration', title: 'Duration', width: 90, numeric: true }, { key: 'wait', title: 'Wait', width: 120 },
      { key: 'blockedBy', title: 'Blocked by', width: 120 }, { key: 'command', title: 'Command', width: 110 },
      { key: 'text', title: 'Statement', width: 320 }, { key: 'cpu', title: 'CPU', width: 70, numeric: true },
      { key: 'reads', title: 'Reads', width: 80, numeric: true },
    ];
  return all.filter((c) => c.key === 'id' || c.key === 'state' || rows.some((r) => cellValue(r, c.key) !== ''));
}

/** 850 ms, 12.4 s, 3 m 05 s, 2 h 14 m, 3 d 4 h. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${pad(Math.floor(s % 60))} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${pad(m % 60)} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export type KillMode = 'terminate' | 'cancel';

/** Statement shown in the Kill confirmation (engine `fields.killStatement` / `cancelStatement`, else a best guess). */
export function killStatement(r: ActivityRow, mode: KillMode, providerId: string | undefined): string {
  if (mode === 'cancel') return r.fields?.cancelStatement ?? `SELECT pg_cancel_backend(${r.id})`;
  if (r.fields?.killStatement) return r.fields.killStatement;
  switch (providerId) {
    case 'sqlserver': return `KILL ${r.id}`;
    case 'oracle': return `ALTER SYSTEM KILL SESSION '${r.id}' IMMEDIATE`;
    case 'postgresql': return `SELECT pg_terminate_backend(${r.id})`;
    case 'redis': return `CLIENT KILL ID ${r.id}`;
    case 'mongodb': return `db.killOp(${r.id})`;
    case 'kafka': return `Cancel job ${r.id}`;
    default: return `Kill ${r.id}`;
  }
}

/** PostgreSQL rows offer Cancel query besides Terminate. */
export function canCancelRow(r: ActivityRow | null | undefined, providerId: string | undefined): boolean {
  return !!r && r.canKill && r.kind !== 'lock' && (providerId === 'postgresql' || !!r.fields?.cancelStatement) && !isIdle(r);
}

/** `detail.needs` of a 403 PRIVILEGE error. */
export function needsOf(detail: unknown): string | null {
  if (detail && typeof detail === 'object' && typeof (detail as { needs?: unknown }).needs === 'string') return (detail as { needs: string }).needs;
  return null;
}
