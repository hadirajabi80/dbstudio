// Small UI text helpers shared by the shell components.
import type { ConnectionActivity } from '../../store/sessions';

/** "1 session" / "3 sessions" / "1 batch" / "2 batches"; `plural` defaults to `${singular}s`. */
export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`;
}

/** The word alone: "row" / "rows" (when the number is formatted elsewhere). */
export function pluralWord(n: number, singular: string, plural = `${singular}s`): string {
  return n === 1 ? singular : plural;
}

/** Title of the explorer's connected dot: says which kind of "connected" it is. */
export function activityTitle(a: ConnectionActivity): string {
  if (!a) return 'Not connected';
  return a.kind === 'session' ? `Connected · ${pluralize(a.sessions, 'open session')}` : 'Connected · catalog loaded (no open session)';
}
