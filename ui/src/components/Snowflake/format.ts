// Pure helpers of the Snowflake views (plan-batch3 WP-SF).
import type { LogEntry } from '../../api/types';
import type { SnowflakeObjectKind } from '../../api/types.snowflake';

/** Object actions per kind (engine SnowflakeObjects.ObjectActionSql). */
export const OBJECT_ACTIONS: Partial<Record<SnowflakeObjectKind, string[]>> = {
  tasks: ['resume', 'suspend', 'execute'],
  dynamictables: ['refresh', 'suspend', 'resume'],
  pipes: ['refresh'],
  alerts: ['resume', 'suspend'],
};

export function formatMs(ms: string | undefined): string {
  const n = Number(ms);
  if (!ms || !Number.isFinite(n)) return '';
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.floor(n / 60_000)} min ${Math.round((n % 60_000) / 1000)} s`;
}

export function formatBytes(b: string | undefined): string {
  const n = Number(b);
  if (!b || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** The full statement of a query_history entry: the detail (after the error message for failed ones), else the message. */
export function queryText(e: LogEntry): string {
  if (!e.detail) return e.message;
  if (!e.fields?.errorCode) return e.detail;
  const i = e.detail.indexOf('\n\n');
  return i >= 0 ? e.detail.slice(i + 2) : e.message;
}
