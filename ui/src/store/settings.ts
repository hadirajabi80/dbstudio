import { create } from 'zustand';
import { api } from '../api/client';
import type { ConnectionsSettings, FormatOptions, GridSettings, Settings, Snippet } from '../api/types';

export const DEFAULT_FORMAT: FormatOptions = {
  keywordCase: 'upper',
  identifierCase: 'asIs',
  indent: 4,
  useTabs: false,
  commaStyle: 'trailing',
  lineWidth: 120,
  clauseKeywordsOnOwnLine: true,
  andOrOnNewLine: true,
  alignAliases: false,
  blankLineBetweenStatements: 1,
  maxConsecutiveBlankLines: 1,
  functionCase: 'upper',
  datatypeCase: 'upper',
  formatDdlOnOpen: true,
};

export const DEFAULT_GRID: GridSettings = { density: 'comfortable', pageSize: 1000, verifyUnchanged: false, showSqlBeforeSave: false };
export const DEFAULT_CONNECTIONS: ConnectionsSettings = { maxSessionsPerProfile: 8 };

/** Settings with every M1.5 key present (the engine always returns them; the defaults cover older engines). */
export type FullSettings = Settings & {
  format: FormatOptions;
  snippets: Snippet[];
  grid: GridSettings;
  connections: ConnectionsSettings;
  ui: Record<string, unknown>;
};

export const DEFAULT_SETTINGS: FullSettings = {
  theme: 'system',
  editor: {
    fontSize: 14,
    keywordCase: 'upper',
    identifierCase: 'asIs',
    qualifyObjects: 'nonDefaultSchema',
    qualifyColumns: 'ambiguous',
    tabSize: 4,
    blankLineSplitsStatements: true,
  },
  results: { maxRows: 10000, nullText: 'NULL', dateFormat: 'iso' },
  confirmDestructive: true,
  ui: {},
  format: DEFAULT_FORMAT,
  snippets: [],
  grid: DEFAULT_GRID,
  connections: DEFAULT_CONNECTIONS,
};

export type SettingsPatch = {
  theme?: Settings['theme'];
  editor?: Partial<Settings['editor']>;
  results?: Partial<Settings['results']>;
  confirmDestructive?: boolean;
  ui?: Record<string, unknown>;
  format?: Partial<FormatOptions>;
  /** Replaces the whole list. */
  snippets?: Snippet[];
  grid?: Partial<GridSettings>;
  connections?: Partial<ConnectionsSettings>;
};

const THEMES = new Set(['system', 'light', 'dark']);

/** Partial merge with the engine's semantics: objects merge one level deep, arrays and scalars replace. */
export function mergeSettings(s: FullSettings, p: SettingsPatch | Partial<Settings> | null | undefined): FullSettings {
  if (!p) return s;
  return {
    ...s,
    ...(p.theme && THEMES.has(p.theme) ? { theme: p.theme } : {}),
    ...(p.confirmDestructive !== undefined ? { confirmDestructive: p.confirmDestructive } : {}),
    editor: { ...s.editor, ...p.editor },
    results: { ...s.results, ...p.results },
    ui: { ...s.ui, ...p.ui },
    format: { ...s.format, ...p.format },
    snippets: Array.isArray(p.snippets) ? p.snippets : s.snippets,
    grid: { ...s.grid, ...p.grid },
    connections: { ...s.connections, ...p.connections },
  };
}

interface SettingsState {
  settings: FullSettings;
  loaded: boolean;
  load(): Promise<void>;
  /** Optimistic update; the engine receives a debounced partial merge. */
  update(patch: SettingsPatch): void;
}

let pending: SettingsPatch = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function mergeObj<T extends object>(a: T | undefined, b: T | undefined): T | undefined {
  return a || b ? ({ ...a, ...b } as T) : undefined;
}

function queuePut(patch: SettingsPatch) {
  pending = {
    ...pending,
    ...patch,
    editor: mergeObj(pending.editor, patch.editor),
    results: mergeObj(pending.results, patch.results),
    ui: mergeObj(pending.ui, patch.ui),
    format: mergeObj(pending.format, patch.format),
    grid: mergeObj(pending.grid, patch.grid),
    connections: mergeObj(pending.connections, patch.connections),
  };
  for (const k of Object.keys(pending) as (keyof SettingsPatch)[]) if (pending[k] === undefined) delete pending[k];
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const body = pending;
    pending = {};
    timer = null;
    api.putSettings(body as Partial<Settings>).catch((e) => console.warn('[settings] save failed', e));
  }, 600);
}

let loading: Promise<void> | null = null;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load() {
    // Concurrent callers share one request.
    if (loading) return loading;
    loading = (async () => {
      try {
        const s = await api.getSettings();
        set({ settings: mergeSettings(DEFAULT_SETTINGS, s), loaded: true });
      } catch (e) {
        console.warn('[settings] load failed, using defaults', e);
        set({ loaded: true });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  update(patch) {
    set({ settings: mergeSettings(get().settings, patch) });
    queuePut(patch);
  },
}));

/** settings.ui key of "Automatically check for updates" (desktop; kept in the free-form ui object, no engine change). */
export const AUTO_CHECK_UPDATES_KEY = 'autoCheckUpdates';

/** "Automatically check for updates": on unless the user turned it off. */
export function autoCheckUpdates(s: Pick<FullSettings, 'ui'> = useSettings.getState().settings): boolean {
  return s.ui[AUTO_CHECK_UPDATES_KEY] !== false;
}

/** Typed read of a free-form `settings.ui` key. */
export function uiSetting<T>(key: string, fallback: T): T {
  const v = useSettings.getState().settings.ui[key];
  return v === undefined ? fallback : (v as T);
}
