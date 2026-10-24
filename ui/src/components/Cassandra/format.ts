// Formatting and trace-timeline helpers of the Cassandra views (pure, unit-tested).
import type { CqlTrace, CqlTraceEvent } from '../../api/types.cassandra';

/** Microseconds as "842 µs", "2.41 ms", "1.20 s". */
export function formatMicros(us: number | null | undefined): string {
  if (us === null || us === undefined || !Number.isFinite(us)) return '—';
  if (Math.abs(us) < 1000) return `${Math.round(us)} µs`;
  if (Math.abs(us) < 1_000_000) return `${(us / 1000).toFixed(us < 10_000 ? 2 : 1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${v} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString('en-US');
}

/** Seconds as a short duration ("90 days", "10 days", "3 h", "45 s"); 0 = "none". */
export function formatSeconds(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return 'none';
  const units: [number, string][] = [[86_400, 'day'], [3600, 'h'], [60, 'min'], [1, 's']];
  for (const [size, name] of units) {
    if (s >= size && s % size === 0) {
      const v = s / size;
      return name === 'day' ? `${v} day${v === 1 ? '' : 's'}` : `${v} ${name}`;
    }
  }
  return `${s} s`;
}

/** Last part of a Java class name ("org.apache.cassandra.index.sai.StorageAttachedIndex" → "StorageAttachedIndex"). */
export function shortClass(name: string | null | undefined): string {
  if (!name) return '';
  return name.slice(name.lastIndexOf('.') + 1);
}

/** The `class` of a map option literal ("{'class': 'org…SizeTieredCompactionStrategy', …}"), shortened. */
export function optionClass(literal: string | undefined): string | null {
  const m = literal ? /'class'\s*:\s*'([^']+)'/.exec(literal) : null;
  return m ? shortClass(m[1]) : null;
}

const UUID_V1 = /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 100-ns ticks of a version-1 (time-based) UUID, or null for any other id. */
export function timeuuidTicks(id: string): bigint | null {
  const m = UUID_V1.exec(id);
  if (!m) return null;
  return (BigInt(`0x${m[3]}`) << 48n) | (BigInt(`0x${m[2]}`) << 32n) | BigInt(`0x${m[1]}`);
}

export interface TimelineEvent extends CqlTraceEvent {
  /** Microseconds since the coordinator received the request. */
  at: number;
  /** Microseconds since the previous event of the same node (or since the node received the request). */
  step: number;
}

export interface TimelineNode {
  source: string;
  coordinator: boolean;
  /** When the node received its part of the request (µs since the coordinator received it). */
  start: number;
  end: number;
  events: TimelineEvent[];
}

export interface Timeline {
  /** Request duration (µs): the trace's duration, else the last event. */
  total: number;
  nodes: TimelineNode[];
  /** Every event, in time order. */
  events: TimelineEvent[];
  /**
   * True when the event ids are time-based UUIDs, so replica events are placed on the coordinator's clock. False: each
   * node's events are drawn from its own `source_elapsed` (replica offsets unknown).
   */
  aligned: boolean;
}

/**
 * Places the events of a trace on one time axis. `source_elapsed` counts from when each node received the request, so
 * replica events need the node's offset: it comes from the event ids (timeuuids, 100 ns resolution), anchored on the
 * coordinator's events (`ticks - source_elapsed` = the moment the coordinator received the request).
 */
export function buildTimeline(trace: CqlTrace): Timeline {
  const coord = trace.coordinator ?? trace.events[0]?.source ?? '';
  const ticks = trace.events.map((e) => timeuuidTicks(e.eventId));
  const aligned = trace.events.length > 0 && ticks.every((t) => t !== null);
  let base: bigint | null = null;
  if (aligned) {
    for (let i = 0; i < trace.events.length; i++) {
      const e = trace.events[i];
      if (e.source !== coord) continue;
      const t = ticks[i]! - BigInt(Math.round(e.sourceElapsedMicros * 10));
      if (base === null || t < base) base = t;
    }
    // no coordinator event: anchor on the earliest event
    if (base === null) for (const t of ticks) if (base === null || t! < base) base = t;
  }
  const anchor = base;
  const placed = trace.events.map((e, i): TimelineEvent => ({
    ...e,
    at: anchor !== null ? Number(ticks[i]! - anchor) / 10 : e.sourceElapsedMicros,
    step: 0,
  }));
  const events = [...placed].sort((a, b) => a.at - b.at);
  const order: string[] = [];
  const bySource = new Map<string, TimelineEvent[]>();
  for (const e of events) {
    if (!bySource.has(e.source)) {
      bySource.set(e.source, []);
      order.push(e.source);
    }
    bySource.get(e.source)!.push(e);
  }
  // the coordinator first, then the replicas in the order they joined
  order.sort((a, b) => (a === coord ? -1 : b === coord ? 1 : 0));
  const nodes = order.map((source): TimelineNode => {
    const list = bySource.get(source)!;
    const start = Math.max(0, list[0].at - list[0].sourceElapsedMicros);
    let prev = start;
    for (const e of list) {
      e.step = Math.max(0, e.at - prev);
      prev = e.at;
    }
    return { source, coordinator: source === coord, start, end: list[list.length - 1].at, events: list };
  });
  const last = events.length ? Math.max(...events.map((e) => e.at)) : 0;
  return { total: Math.max(trace.durationMicros ?? 0, last, 1), nodes, events, aligned };
}

/** Axis ticks (µs) at "nice" steps for a duration. */
export function axisTicks(total: number, count = 4): number[] {
  if (total <= 0) return [0];
  const raw = total / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= total + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}
