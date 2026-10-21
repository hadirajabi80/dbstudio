// Formatting helpers of the Kafka views (no React).
import type { KafkaDecoded, KafkaMessage } from '../../api/types';

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** `2026-10-18 14:02:11.123` in local time. */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The text of a decoded payload; null payloads read `null`, truncated ones their first 32 KB. */
export function decodedText(d: KafkaDecoded | null | undefined): string {
  if (!d || d.text === null || d.text === undefined) return 'null';
  return typeof d.text === 'string' ? d.text : d.text.$trunc;
}

export function isTruncated(d: KafkaDecoded | null | undefined): boolean {
  return !!d && d.text !== null && typeof d.text === 'object';
}

/** One-line preview for the grid. */
export function preview(d: KafkaDecoded | null | undefined, max = 160): string {
  const t = decodedText(d).replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Pretty JSON when the payload parsed, else the text. */
export function prettyText(d: KafkaDecoded, pretty: boolean): string {
  if (pretty && d.json !== undefined && !isTruncated(d)) {
    try {
      return JSON.stringify(d.json, null, 2);
    } catch {
      /* fall through */
    }
  }
  return decodedText(d);
}

export const messageKey = (m: Pick<KafkaMessage, 'partition' | 'offset'>) => `${m.partition}:${m.offset}`;

/** Newest first by timestamp, then partition/offset (stable across merges). */
export function sortMessages(list: KafkaMessage[], order: 'newest' | 'oldest'): KafkaMessage[] {
  const dir = order === 'newest' ? -1 : 1;
  return [...list].sort((a, b) => (a.timestamp < b.timestamp ? -dir : a.timestamp > b.timestamp ? dir : a.partition - b.partition || a.offset - b.offset));
}

/** Lag heat class: thresholds configurable via the Groups view (warn ≥ warnAt, danger ≥ dangerAt). */
export function lagClass(lag: number | null | undefined, warnAt: number, dangerAt: number): string {
  if (lag === null || lag === undefined) return 'kafka-lag-unknown';
  if (lag >= dangerAt) return 'kafka-lag-danger';
  if (lag >= warnAt) return 'kafka-lag-warn';
  return 'kafka-lag-ok';
}

/** `${i}` substitution of "Repeat N times" (1-based). */
export function substitute(text: string, i: number): string {
  return text.replace(/\$\{i\}/g, String(i));
}

/** Datetime-local input value (local time, minutes) ⇄ ISO. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
