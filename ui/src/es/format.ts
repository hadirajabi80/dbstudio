// Small formatting helpers of the Elasticsearch views (plan-batch3 WP-ES). Pure; no React.

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 10_000) return n.toLocaleString('en-US');
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s % 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Percent 0..100 of used/total, null when unknown. */
export function percent(used: number | null | undefined, total: number | null | undefined): number | null {
  if (used == null || total == null || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** Index names (Elasticsearch rules: lowercase, no `\ / * ? " < > | , #` or spaces, not starting with `-_+`, ≤ 255 bytes). */
export function indexNameError(name: string): string | null {
  if (!name) return 'An index name is required.';
  if (name !== name.toLowerCase()) return 'Index names must be lowercase.';
  if (/[\\/*?"<>|,# ]/.test(name)) return 'Index names cannot contain spaces or \\ / * ? " < > | , #.';
  if (/^[-_+]/.test(name)) return 'Index names cannot start with -, _ or +.';
  if (name === '.' || name === '..') return 'Index names cannot be . or ..';
  if (new TextEncoder().encode(name).length > 255) return 'Index names are at most 255 bytes.';
  return null;
}
