import { describe, expect, it } from 'vitest';
import type { ActivityRow, LogEntry, LogSourceInfo } from '../../api/types';
import {
  activityColumns, activitySummary, archiveOptions, blockers, blockingChain, canCancelRow, ENGINE_SOURCE_FALLBACK, entryMatches, entryText,
  expandLevels, exportFileName, filterActivity, formatDuration, formatEntries, formatTime, highlight, isIdle, killStatement, levelVisible,
  makeMatcher, mergeSources, needsOf, parseConfigSet, parseProfilingHint, serverQuery, TailBuffer, timeRange,
} from './model';
import { defaultLogsState, normalizeLogsState } from './open';

const e = (seq: number, o: Partial<LogEntry> = {}): LogEntry => ({ ts: '2026-10-18T12:00:00.000Z', level: 'info', source: 'Server', message: `message ${seq}`, seq, ...o });
const s = (id: string, o: Partial<LogSourceInfo> = {}): LogSourceInfo => ({ id, title: id, kind: 'log', supportsTail: true, supportsRange: true, levels: [], available: true, ...o });
const row = (id: string, o: Partial<ActivityRow> = {}): ActivityRow => ({ id, kind: 'session', state: 'running', canKill: true, ...o });

describe('levels', () => {
  it('expands chips for the server: fatal rides with error, unknown is always included', () => {
    expect(expandLevels(['warn', 'error'])).toEqual(['warn', 'error', 'fatal', 'unknown']);
    expect(expandLevels([])).toEqual(['unknown']);
    expect(expandLevels(['debug', 'info'])).toEqual(['debug', 'info', 'unknown']);
  });

  it('shows fatal under the error chip and unknown always', () => {
    expect(levelVisible('fatal', ['error'])).toBe(true);
    expect(levelVisible('fatal', ['warn'])).toBe(false);
    expect(levelVisible('unknown', [])).toBe(true);
    expect(levelVisible('debug', ['info', 'warn', 'error'])).toBe(false);
  });
});

describe('time presets', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  it('computes from for each preset and keeps to open (now)', () => {
    expect(timeRange('15m', now, null, null)).toEqual({ from: '2026-10-18T11:45:00.000Z', to: undefined });
    expect(timeRange('1h', now, null, null).from).toBe('2026-10-18T11:00:00.000Z');
    expect(timeRange('24h', now, null, null).from).toBe('2026-10-17T12:00:00.000Z');
    expect(timeRange('7d', now, null, null).from).toBe('2026-10-11T12:00:00.000Z');
  });
  it('uses the custom range and ignores invalid dates', () => {
    expect(timeRange('custom', now, '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' });
    expect(timeRange('custom', now, 'nope', null)).toEqual({ from: undefined, to: undefined });
  });
});

describe('search', () => {
  it('matches case-insensitive substrings and highlights every hit', () => {
    const m = makeMatcher('login');
    expect(m.regex).toBe(false);
    expect(m.test('Login failed for user')).toBe(true);
    expect(highlight('Login ok, login failed', m.pattern)).toEqual([
      { text: 'Login', hit: true }, { text: ' ok, ', hit: false }, { text: 'login', hit: true }, { text: ' failed', hit: false },
    ]);
  });

  it('uses a valid regex and falls back to a literal for an invalid one', () => {
    const re = makeMatcher('err(or)?\\s+\\d+');
    expect(re.regex).toBe(true);
    expect(re.test('Error 1105')).toBe(true);
    const lit = makeMatcher('Process ID (73');
    expect(lit.regex).toBe(false);
    expect(lit.test('Transaction (Process ID (73) was')).toBe(true);
    expect(lit.test('Process ID 73')).toBe(false);
  });

  it('treats a pattern matching the empty string literally, and an empty search as match-all', () => {
    expect(makeMatcher('a*').regex).toBe(false);
    const all = makeMatcher('  ');
    expect(all.empty).toBe(true);
    expect(all.test('anything')).toBe(true);
    expect(highlight('abc', all.pattern)).toEqual([{ text: 'abc', hit: false }]);
  });

  it('sends only plain text to the server', () => {
    expect(serverQuery('Login failed')).toBe('Login failed');
    expect(serverQuery('err|warn')).toBeUndefined();
    expect(serverQuery('  ')).toBeUndefined();
  });

  it('filters entries by level and text (message, source, detail)', () => {
    const m = makeMatcher('filegroup');
    expect(entryMatches(e(1, { level: 'error', detail: 'PRIMARY filegroup is full' }), ['error'], m)).toBe(true);
    expect(entryMatches(e(2, { level: 'error' }), ['error'], m)).toBe(false);
    expect(entryMatches(e(3, { level: 'debug', message: 'filegroup' }), ['info'], m)).toBe(false);
    expect(entryMatches(e(4, { source: 'spid52' }), ['info'], makeMatcher('SPID5'))).toBe(true);
  });
});

describe('TailBuffer', () => {
  it('caps at 20,000 entries by default, evicting the oldest and counting them', () => {
    const b = new TailBuffer();
    expect(b.cap).toBe(20_000);
    b.push(Array.from({ length: 19_990 }, (_, i) => e(i + 1)));
    expect(b.evicted).toBe(0);
    expect(b.push(Array.from({ length: 25 }, (_, i) => e(19_991 + i)))).toBe(15);
    expect(b.size).toBe(20_000);
    expect(b.evicted).toBe(15);
    expect(b.oldestSeq()).toBe(16);
  });

  it('skips duplicate seqs (tail items already returned by the query)', () => {
    const b = new TailBuffer(10);
    b.replace([e(1), e(2), e(3)]);
    b.push([e(3), e(4)]);
    expect(b.entries.map((x) => x.seq)).toEqual([1, 2, 3, 4]);
  });

  it('prepends older entries only up to the cap', () => {
    const b = new TailBuffer(5);
    b.replace([e(10), e(11), e(12)]);
    expect(b.prepend([e(6), e(7), e(8), e(9)])).toBe(2);
    expect(b.entries.map((x) => x.seq)).toEqual([8, 9, 10, 11, 12]);
  });

  it('replace keeps the newest cap entries; clear resets the counters', () => {
    const b = new TailBuffer(3);
    b.replace([e(1), e(2), e(3), e(4)]);
    expect(b.entries.map((x) => x.seq)).toEqual([2, 3, 4]);
    b.push([e(5)]);
    expect(b.evicted).toBe(1);
    b.clear();
    expect(b.size).toBe(0);
    expect(b.evicted).toBe(0);
    expect(b.oldestSeq()).toBeNull();
  });
});

describe('sources', () => {
  it('merges the connection sources with the engine log; the activity entry is kept apart', () => {
    const m = mergeSources('c1', [s('errorlog'), s('activity', { kind: 'activity' }), s('system_health', { available: false })], [s('engine')]);
    expect(m.logs.map((x) => `${x.cid}/${x.info.id}`)).toEqual(['c1/errorlog', 'c1/system_health', 'engine/engine']);
    expect(m.activity?.id).toBe('activity');
  });

  it('SQLite (no sources) and the engine tab show the engine log only', () => {
    const sqlite = mergeSources('c_shop', [], [s('engine')]);
    expect(sqlite.logs.map((x) => x.info.id)).toEqual(['engine']);
    expect(sqlite.activity).toBeNull();
    const eng = mergeSources('engine', [s('errorlog')], [s('engine')]);
    expect(eng.logs.map((x) => x.cid)).toEqual(['engine']);
  });

  it('falls back to a built-in engine source when the engine sources could not be read', () => {
    const m = mergeSources('c1', null, null);
    expect(m.logs).toEqual([{ info: ENGINE_SOURCE_FALLBACK, cid: 'engine' }]);
  });

  it('offers archives for the SQL Server error and agent logs (engine list or Current + #1…#6)', () => {
    expect(archiveOptions(s('errorlog')).map((o) => o.label)).toEqual(['Current', 'Archive #1', 'Archive #2', 'Archive #3', 'Archive #4', 'Archive #5', 'Archive #6']);
    const withList = archiveOptions({ ...s('agentlog'), archives: [{ index: 1, date: null, sizeBytes: 1 }, { index: 0, date: null, sizeBytes: 2 }] });
    expect(withList).toEqual([{ value: 0, label: 'Current' }, { value: 1, label: 'Archive #1' }]);
    expect(archiveOptions(s('alert'))).toEqual([]);
  });

  it('reads CONFIG SET hints and PRIVILEGE details', () => {
    expect(parseConfigSet('CONFIG SET latency-monitor-threshold 100')).toEqual({ name: 'latency-monitor-threshold', value: '100' });
    expect(parseConfigSet('GRANT VIEW SERVER STATE TO [app];')).toBeNull();
    expect(parseProfilingHint('profiler:shop', 'db.getSiblingDB("shop").setProfilingLevel(1, { slowms: 250 })')).toEqual({ db: 'shop', level: 1, slowms: 250 });
    expect(parseProfilingHint('profiler:shop', 'db.setProfilingLevel(2)')).toEqual({ db: 'shop', level: 2, slowms: 100 });
    expect(parseProfilingHint('getLog', 'db.setProfilingLevel(1, { slowms: 100 })')).toBeNull();
    expect(parseProfilingHint('profiler:shop', 'db.getSiblingDB("admin").grantRolesToUser("app", [{ role: "dbAdmin", db: "shop" }])')).toBeNull();
    expect(needsOf({ needs: 'GRANT X' })).toBe('GRANT X');
    expect(needsOf(null)).toBeNull();
  });
});

describe('formatting and export', () => {
  const entries = [
    e(1, { level: 'warn', source: 'Logon', message: 'Login failed, "app"', fields: { state: '8' } }),
    e(2, { level: 'error', message: 'Error: 1105', detail: 'line one\nline two' }),
  ];

  it('formats the time as HH:mm:ss.SSS local', () => {
    const d = new Date(2026, 9, 18, 14, 2, 11, 213);
    expect(formatTime(d.toISOString())).toBe('14:02:11.213');
    expect(formatTime(null)).toBe('—');
  });

  it('exports text with detail and fields indented', () => {
    const txt = formatEntries(entries, 'txt');
    expect(txt.split('\n')[0]).toBe('2026-10-18T12:00:00.000Z WARN  [Logon] Login failed, "app"');
    expect(txt).toContain('    state: 8');
    expect(txt).toContain('    line one\n    line two');
    expect(entryText(entries[1])).toBe('2026-10-18T12:00:00.000Z ERROR [Server] Error: 1105\n    line one\n    line two');
  });

  it('exports RFC 4180 CSV', () => {
    const csv = formatEntries(entries, 'csv').split('\r\n');
    expect(csv[0]).toBe('ts,level,source,message,detail,fields');
    expect(csv[1]).toBe('2026-10-18T12:00:00.000Z,warn,Logon,"Login failed, ""app""",,"{""state"":""8""}"');
    expect(csv[2]).toBe('2026-10-18T12:00:00.000Z,error,Server,Error: 1105,"line one\nline two",');
  });

  it('exports JSON that parses back', () => {
    const json = JSON.parse(formatEntries(entries, 'json')) as LogEntry[];
    expect(json).toHaveLength(2);
    expect(json[0]).toMatchObject({ level: 'warn', fields: { state: '8' }, seq: 1, detail: null });
    expect(exportFileName('profiler:shop', 'json', new Date(2026, 9, 18, 9, 5, 7))).toBe('logs-profiler_shop-20261018-090507.json');
  });
});

describe('activity', () => {
  const rows = [
    row('52', { state: 'sleeping' }),
    row('57', { durationMs: 95_000, command: 'UPDATE' }),
    row('61', { state: 'suspended', blockedBy: '57', durationMs: 64_000 }),
    row('64', { state: 'suspended', blockedBy: '57', durationMs: 31_000 }),
    row('70', { state: 'suspended', blockedBy: '61', durationMs: 12_000 }),
    row('lock:1', { kind: 'lock', state: 'WAIT', blockedBy: '57', canKill: false, fields: { resource: 'OBJECT: dbo.Orders', mode: 'IX', count: '1' } }),
  ];

  it('summarises sessions, running, blocked and the longest running (locks excluded)', () => {
    const sum = activitySummary(rows);
    expect(sum).toMatchObject({ sessions: 5, running: 4, blocked: 3 });
    expect(sum.longest?.id).toBe('57');
    expect(isIdle(row('x', { state: 'idle in transaction' }))).toBe(true);
    expect(isIdle(row('x', { state: 'active' }))).toBe(false);
  });

  it('finds blockers, the head blocker and the chain', () => {
    const b = blockers(rows);
    expect([...b.all].sort()).toEqual(['57', '61']);
    expect([...b.head]).toEqual(['57']);
    expect(blockingChain(rows, '70')).toEqual(['61', '57']);
    expect(blockingChain([row('a', { blockedBy: 'b' }), row('b', { blockedBy: 'a' })], 'a')).toEqual(['b']);
  });

  it('filters only active (keeping idle blockers), locks mode and search', () => {
    const idleBlocker = [row('9', { state: 'sleeping' }), row('10', { blockedBy: '9' }), row('11', { state: 'sleeping' })];
    expect(filterActivity(idleBlocker, { mode: 'sessions', onlyActive: true, search: '' }).map((r) => r.id)).toEqual(['9', '10']);
    expect(filterActivity(rows, { mode: 'locks', onlyActive: false, search: '' }).map((r) => r.id)).toEqual(['lock:1']);
    expect(filterActivity(rows, { mode: 'sessions', onlyActive: false, search: 'update' }).map((r) => r.id)).toEqual(['57']);
  });

  it('builds columns per provider from the values present', () => {
    const cols = activityColumns([row('1', { user: 'app', text: 'SELECT 1' })], 'postgresql', 'sessions');
    expect(cols.map((c) => c.key)).toEqual(['id', 'user', 'state', 'text']);
    expect(cols[0].title).toBe('PID');
    expect(activityColumns(rows, 'sqlserver', 'locks').map((c) => c.key)).toEqual(['id', 'resource', 'mode', 'state', 'count', 'blockedBy']);
  });

  it('formats durations', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_400)).toBe('12.4 s');
    expect(formatDuration(185_000)).toBe('3 m 05 s');
    expect(formatDuration(8_040_000)).toBe('2 h 14 m');
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe('3 d 4 h');
  });

  it('uses the engine kill / cancel statements, else a provider default', () => {
    expect(killStatement(row('57', { fields: { killStatement: 'KILL 57' } }), 'terminate', 'sqlserver')).toBe('KILL 57');
    expect(killStatement(row('123,4567'), 'terminate', 'oracle')).toBe("ALTER SYSTEM KILL SESSION '123,4567' IMMEDIATE");
    expect(killStatement(row('1234', { fields: { cancelStatement: 'SELECT pg_cancel_backend(1234)' } }), 'cancel', 'postgresql')).toBe('SELECT pg_cancel_backend(1234)');
    expect(killStatement(row('12'), 'terminate', 'redis')).toBe('CLIENT KILL ID 12');
    expect(canCancelRow(row('1', { state: 'active' }), 'postgresql')).toBe(true);
    expect(canCancelRow(row('1', { state: 'idle' }), 'postgresql')).toBe(false);
    expect(canCancelRow(row('1'), 'sqlserver')).toBe(false);
  });
});

describe('tab state', () => {
  it('normalises persisted state and keeps it JSON', () => {
    const st = normalizeLogsState({ sub: 'activity', levels: ['error', 'bogus'], from: 'x', archive: 2.7, streamId: 'st_1' }, 'c_prod');
    expect(st).toMatchObject({ connectionId: 'c_prod', sub: 'activity', levels: ['error'], from: '1h', archive: 2 });
    expect(st).not.toHaveProperty('streamId');
    expect(JSON.parse(JSON.stringify(defaultLogsState('engine')))).toEqual(defaultLogsState('engine'));
  });
});
