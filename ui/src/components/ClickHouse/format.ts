import type { ChMutation } from '../../api/types.clickhouse';

// Number formatting of the ClickHouse views (binary units like formatReadableSize, grouped counts).

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  let v = n;
  let u = 0;
  while (Math.abs(v) >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${UNITS[u]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** Uncompressed / compressed, e.g. "6.0×"; "—" when nothing is compressed. */
export function formatRatio(uncompressed: number, compressed: number): string {
  if (!compressed || !uncompressed) return '—';
  return `${(uncompressed / compressed).toFixed(1)}×`;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

/** "2026-10-14T08:55:00Z" → "2026-10-14 08:55:00" (UTC as reported by the server). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
}

/** Display state of a mutation. */
export function mutationState(m: ChMutation): 'killed' | 'failing' | 'running' | 'done' {
  if (m.isKilled) return 'killed';
  if (!m.isDone && m.latestFailReason) return 'failing';
  return m.isDone ? 'done' : 'running';
}
