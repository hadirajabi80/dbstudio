// Cassandra view helpers: duration/size formatting and the trace timeline (replica events on the coordinator's clock).
import { describe, expect, it } from 'vitest';
import type { CqlTrace, CqlTraceEvent } from '../../../api/types.cassandra';
import { axisTicks, buildTimeline, formatBytes, formatMicros, formatSeconds, optionClass, shortClass, timeuuidTicks } from '../format';

/** A version-1 UUID for `ms` + `us` (same layout as the driver / the mock pack). */
function timeuuid(ms: number, us = 0): string {
  const ticks = BigInt(ms) * 10_000n + BigInt(us * 10) + 0x01b21dd213814000n;
  const hex = ticks.toString(16).padStart(15, '0');
  return `${hex.slice(7)}-${hex.slice(3, 7)}-1${hex.slice(0, 3)}-8001-0242ac110002`;
}

const T0 = Date.UTC(2026, 9, 24, 10, 0, 0);
/** An event `at` µs after the coordinator received the request, logged by `source` (which received it at `offset`). */
const ev = (source: string, at: number, offset: number, activity: string): CqlTraceEvent => ({
  eventId: timeuuid(T0 + Math.floor(at / 1000), at % 1000), activity, source, sourceElapsedMicros: at - offset, thread: 'T', timestamp: new Date(T0).toISOString(),
});

function trace(events: CqlTraceEvent[], durationMicros: number | null = 2000): CqlTrace {
  return {
    traceId: timeuuid(T0), coordinator: '10.0.0.1', client: '10.0.0.9', request: 'Execute CQL3 query', command: 'QUERY',
    startedAt: new Date(T0).toISOString(), durationMicros, parameters: { query: 'SELECT 1' }, events,
  };
}

describe('formatting', () => {
  it('formats microseconds, bytes and seconds', () => {
    expect(formatMicros(842)).toBe('842 µs');
    expect(formatMicros(2410)).toBe('2.41 ms');
    expect(formatMicros(45_600)).toBe('45.6 ms');
    expect(formatMicros(1_200_000)).toBe('1.20 s');
    expect(formatMicros(null)).toBe('—');
    expect(formatBytes(612)).toBe('612 B');
    expect(formatBytes(2_621_440)).toBe('2.5 MB');
    expect(formatBytes(null)).toBe('—');
    expect(formatSeconds(7_776_000)).toBe('90 days');
    expect(formatSeconds(864_000)).toBe('10 days');
    expect(formatSeconds(3600)).toBe('1 h');
    expect(formatSeconds(0)).toBe('none');
  });

  it('shortens class names and reads the class of a map option', () => {
    expect(shortClass('org.apache.cassandra.index.sai.StorageAttachedIndex')).toBe('StorageAttachedIndex');
    expect(optionClass("{'class': 'org.apache.cassandra.db.compaction.TimeWindowCompactionStrategy', 'compaction_window_size': '1'}")).toBe('TimeWindowCompactionStrategy');
    expect(optionClass(undefined)).toBeNull();
  });

  it('reads the ticks of time-based UUIDs only', () => {
    expect(timeuuidTicks(timeuuid(T0, 5))! - timeuuidTicks(timeuuid(T0))!).toBe(50n);
    expect(timeuuidTicks('5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c04')).toBeNull();
  });

  it('picks nice axis ticks', () => {
    expect(axisTicks(2000)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(axisTicks(0)).toEqual([0]);
  });
});

describe('buildTimeline', () => {
  it('places replica events on the coordinator clock and groups them by node, coordinator first', () => {
    const t = trace([
      ev('10.0.0.1', 150, 0, 'Parsing SELECT'),
      ev('10.0.0.2', 900, 700, 'READ_REQ message received'),
      ev('10.0.0.1', 600, 0, 'Sending READ_REQ'),
      ev('10.0.0.2', 1300, 700, 'Read 1 live rows'),
      ev('10.0.0.1', 1700, 0, 'READ_RSP message received'),
    ]);
    const tl = buildTimeline(t);
    expect(tl.aligned).toBe(true);
    expect(tl.total).toBe(2000);
    expect(tl.nodes.map((n) => n.source)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(tl.nodes[0].coordinator).toBe(true);
    const replica = tl.nodes[1];
    expect(replica.start).toBe(700);
    expect(replica.events.map((e) => [e.at, e.step])).toEqual([[900, 200], [1300, 400]]);
    expect(tl.nodes[0].events.map((e) => e.step)).toEqual([150, 450, 1100]);
    expect(tl.events.map((e) => e.at)).toEqual([150, 600, 900, 1300, 1700]);
  });

  it("falls back to each node's own clock when the event ids are not time-based", () => {
    const t = trace([
      { ...ev('10.0.0.1', 100, 0, 'a'), eventId: 'x1' },
      { ...ev('10.0.0.2', 900, 700, 'b'), eventId: 'x2' },
    ], null);
    const tl = buildTimeline(t);
    expect(tl.aligned).toBe(false);
    expect(tl.nodes[1].events[0].at).toBe(200);
    expect(tl.total).toBe(200);
  });
});
