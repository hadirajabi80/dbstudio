// Formatted view of stored DDL (Object tab "Formatted" toggle); see FormattedDdl.tsx for the wiring.
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { Dialect } from '../api/types';
import { formatSql } from '../format';
import { getEditorConfig, onEditorConfigChange } from './config';

export interface FormattedToggleProps {
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  /** Statements the formatter left as they were. */
  warnings: number;
  disabled?: boolean;
}

export interface FormattedDdl {
  /** The text to show: formatted or as stored. */
  text: string;
  formatted: boolean;
  setFormatted: (v: boolean) => void;
  warnings: number;
  toggle: FormattedToggleProps;
}

export function useFormattedDdl(ddl: string | null, dialect: Dialect): FormattedDdl {
  const cfg = useSyncExternalStore(onEditorConfigChange, getEditorConfig, getEditorConfig);
  const [choice, setChoice] = useState<boolean | null>(null);
  const formatted = choice ?? (cfg.format?.formatDdlOnOpen ?? true);
  const result = useMemo(() => (ddl && formatted ? formatSql(ddl, dialect, cfg.format) : null), [ddl, dialect, formatted, cfg.format]);
  const text = result ? result.text : ddl ?? '';
  const warnings = result?.warnings.length ?? 0;
  return {
    text, formatted, setFormatted: setChoice, warnings,
    toggle: { pressed: formatted, onChange: setChoice, warnings, disabled: !ddl },
  };
}

