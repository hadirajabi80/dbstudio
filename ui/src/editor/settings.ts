// Maps the app's editor settings onto intel options.
import type { Settings } from '../api/types';
import type { IntelOptions } from '../intel';
import type { SqlEditorProps } from './SqlEditor.types';

/** Dialects whose scripts end statements at ';' only (no blank-line culture, PLAN 4.4); Batch 3 adds its four. */
const SEMICOLON_ONLY: ReadonlySet<string> = new Set(['sqlite', 'pgsql', 'mysql', 'clickhouse', 'snowflake', 'cql']);

export function intelOptionsFromSettings(s: Settings['editor'] | undefined, dialect: SqlEditorProps['dialect']): Partial<IntelOptions> {
  if (!s) return {};
  return {
    keywordCase: s.keywordCase,
    identifierCase: s.identifierCase,
    qualifyObjects: s.qualifyObjects,
    qualifyColumns: s.qualifyColumns,
    // SQLite, PostgreSQL and the Batch 3 dialects have no blank-line culture: statements end at ';' (PLAN 4.4)
    blankLineSplitsStatements: SEMICOLON_ONLY.has(dialect) ? false : s.blankLineSplitsStatements,
  };
}
