import { create } from 'zustand';
import { api } from '../api/client';
import type { Settings } from '../api/types';

export const DEFAULT_SETTINGS: Settings = {
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
};

export type SettingsPatch = {
  theme?: Settings['theme'];
  editor?: Partial<Settings['editor']>;
  results?: Partial<Settings['results']>;
  confirmDestructive?: boolean;
  ui?: Record<string, unknown>;
};

function merge(s: Settings, p: SettingsPatch): Settings {
  return {
    ...s,
    ...(p.theme ? { theme: p.theme } : {}),
    ...(p.confirmDestructive !== undefined ? { confirmDestructive: p.confirmDestructive } : {}),
    editor: { ...s.editor, ...p.editor },
    results: { ...s.results, ...p.results },
    ui: { ...s.ui, ...p.ui },
  };
}

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  load(): Promise<void>;
  /** Optimistic update; the engine receives a debounced partial merge. */
  update(patch: SettingsPatch): void;
}

let pending: SettingsPatch = {};
let timer: ReturnType<typeof setTimeout> | null = null;

function queuePut(patch: SettingsPatch) {
  pending = {
    ...pending,
    ...patch,
    editor: patch.editor || pending.editor ? { ...pending.editor, ...patch.editor } : undefined,
    results: patch.results || pending.results ? { ...pending.results, ...patch.results } : undefined,
    ui: patch.ui || pending.ui ? { ...pending.ui, ...patch.ui } : undefined,
  };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const body = pending;
    pending = {};
    timer = null;
    api.putSettings(body as Partial<Settings>).catch((e) => console.warn('[settings] save failed', e));
  }, 600);
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  async load() {
    try {
      const s = await api.getSettings();
      set({ settings: merge(DEFAULT_SETTINGS, s as SettingsPatch), loaded: true });
    } catch (e) {
      console.warn('[settings] load failed, using defaults', e);
      set({ loaded: true });
    }
  },
  update(patch) {
    set({ settings: merge(get().settings, patch) });
    queuePut(patch);
  },
}));
