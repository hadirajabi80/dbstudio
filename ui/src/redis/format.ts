// Formatting helpers of the Redis views: TTL / size badges, redis-cli style reply text, table detection.
import type { RedisCommandResult, RedisKeyType, RedisReplyValue } from '../api/types';

/** TTL badge: "45s", "12m 5s", "1h 12m", "3d 4h"; "" for no TTL (-1); "gone" for -2. */
export function formatTtl(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds === -1) return '';
  if (seconds === -2) return 'gone';
  if (seconds < 0) return '';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Parses "90", "90s", "15m", "2h", "1d", "1h 30m" into seconds (null when not a duration). */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  let total = 0;
  let matched = '';
  for (const m of t.matchAll(/(\d+)\s*(d|h|m|s)/g)) {
    total += Number(m[1]) * { d: 86_400, h: 3600, m: 60, s: 1 }[m[2] as 'd' | 'h' | 'm' | 's'];
    matched += m[0];
  }
  return matched.replace(/\s/g, '') === t.replace(/\s/g, '') && total > 0 ? total : null;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const TYPE_LABEL: Record<RedisKeyType, string> = {
  string: 'STRING', hash: 'HASH', list: 'LIST', set: 'SET', zset: 'ZSET', stream: 'STREAM', rejson: 'JSON', unknown: 'OTHER',
};

/** Scores of ±infinity travel as ±Number.MAX_VALUE (JSON has no infinity). */
export function formatScore(score: number): string {
  if (score >= Number.MAX_VALUE) return '+inf';
  if (score <= -Number.MAX_VALUE) return '-inf';
  return String(score);
}

/** redis-cli rendering of one reply. */
export function replyText(r: Pick<RedisCommandResult, 'type' | 'value'>): string {
  if (r.type === 'error') return `(error) ${String(r.value)}`;
  // multi-line bulk replies (INFO, CLIENT LIST, LATENCY DOCTOR) read better unquoted (like redis-cli --raw)
  if (r.type === 'bulk' && typeof r.value === 'string' && r.value.includes('\n')) return r.value.replace(/\r\n/g, '\n');
  return render(r.value, r.type === 'simple' ? 'simple' : r.type === 'int' ? 'int' : 'auto', 0);
}

function render(v: RedisReplyValue, hint: 'simple' | 'int' | 'auto', indent: number): string {
  if (v === null) return '(nil)';
  if (typeof v === 'number') return `(integer) ${v}`;
  if (typeof v === 'string') return hint === 'simple' ? v : JSON.stringify(v);
  if (!v.length) return '(empty array)';
  const width = String(v.length).length;
  return v
    .map((item, i) => {
      const label = `${String(i + 1).padStart(width)}) `;
      const body = render(item, 'auto', indent + label.length);
      return (i === 0 ? '' : ' '.repeat(indent)) + label + body;
    })
    .join('\n');
}

/** Commands whose flat array reply is field/value pairs. */
const PAIR_COMMANDS = new Set(['HGETALL', 'CONFIG GET', 'HRANDFIELD', 'XINFO STREAM', 'MEMORY STATS', 'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE',
  'ZPOPMIN', 'ZPOPMAX', 'ZRANDMEMBER', 'HELLO', 'ACL GETUSER', 'FT.INFO', 'TS.INFO']);

export interface ReplyTable {
  columns: string[];
  rows: string[][];
}

const cell = (v: RedisReplyValue): string => (v === null ? '(nil)' : Array.isArray(v) ? JSON.stringify(v) : String(v));

/**
 * A table view of a reply: arrays of equal-length arrays (XINFO GROUPS, SLOWLOG GET...) become rows; flat pair
 * replies of hash-like commands (HGETALL, CONFIG GET, ZRANGE WITHSCORES...) become field/value rows.
 */
export function replyTable(command: string, args: readonly string[], value: RedisReplyValue): ReplyTable | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.every((x) => Array.isArray(x))) {
    const rows = value as RedisReplyValue[][];
    // arrays of flat maps (XINFO GROUPS, XINFO CONSUMERS): column names from the even positions
    const mapLike = rows.every((r) => r.length % 2 === 0 && r.every((x, i) => i % 2 === 1 || typeof x === 'string'));
    if (mapLike && rows.length > 0 && rows[0].length >= 2) {
      const columns = rows[0].filter((_, i) => i % 2 === 0).map(cell);
      if (rows.every((r) => r.filter((_, i) => i % 2 === 0).map(cell).join('\u0001') === columns.join('\u0001')))
        return { columns, rows: rows.map((r) => r.filter((_, i) => i % 2 === 1).map(cell)) };
    }
    const width = Math.max(...rows.map((r) => r.length));
    if (width < 2) return null;
    return { columns: Array.from({ length: width }, (_, i) => `#${i + 1}`), rows: rows.map((r) => Array.from({ length: width }, (_, i) => (i < r.length ? cell(r[i]) : ''))) };
  }
  const withScores = args.some((a) => a.toUpperCase() === 'WITHSCORES' || a.toUpperCase() === 'WITHVALUES');
  const pairs = PAIR_COMMANDS.has(command) && (withScores || !command.startsWith('Z') && command !== 'HRANDFIELD');
  if (pairs && value.length % 2 === 0) {
    const zset = command.startsWith('Z');
    const rows: string[][] = [];
    for (let i = 0; i < value.length; i += 2) rows.push([cell(value[i]), cell(value[i + 1])]);
    return { columns: zset ? ['member', 'score'] : ['field', 'value'], rows };
  }
  if (value.every((x) => !Array.isArray(x))) return { columns: ['#', 'value'], rows: value.map((x, i) => [String(i + 1), cell(x)]) };
  return null;
}

/** Pretty JSON when a bulk reply is a JSON object or array. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}
