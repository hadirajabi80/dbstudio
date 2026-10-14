// Maps the app's editor settings onto intel options.
import type { Settings } from '../api/types';
import type { IntelOptions } from '../intel';
import type { SqlEditorProps } from './SqlEditor.types';

export function intelOptionsFromSettings(s: Settings['editor'] | undefined, dialect: SqlEditorProps['dialect']): Partial<IntelOptions> {
  if (!s) return {};
  return {
    keywordCase: s.keywordCase,
    identifierCase: s.identifierCase,
    qualifyObjects: s.qualifyObjects,
    qualifyColumns: s.qualifyColumns,
    // SQLite scripts have no blank-line culture: statements end at ';' (PLAN 4.4)
    blankLineSplitsStatements: dialect === 'sqlite' ? false : s.blankLineSplitsStatements,
  };
}
