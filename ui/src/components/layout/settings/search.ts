// Settings search: the query the rows filter on, and the matching rule (every word must appear).
import { createContext } from 'react';

/** The settings search query (lower-case, trimmed); '' shows everything. */
export const SettingsQuery = createContext('');

export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
  if (!query) return true;
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return query.split(/\s+/).every((w) => hay.includes(w));
}
