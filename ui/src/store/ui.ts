import { create } from 'zustand';
import type { ProviderId } from '../api/types';
import type { WsStatus } from '../api/ws';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  detail?: string;
  /** Optional action button ("Undo", "Close idle tabs", ...). */
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Optional list shown as bullet points (e.g. destructive statements found). */
  items?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export type ConnectionDialogState =
  | { mode: 'new'; providerId?: ProviderId; folder?: string | null; /** "Connect" opens a console after saving. */ connectAfter?: boolean }
  | { mode: 'edit'; id: string }
  | { mode: 'duplicate'; id: string };

/** Left dock panels (tabbed). */
export type DockPanel = 'explorer' | 'history' | 'connections';

export type PaletteMode = 'commands' | 'objects';

/** Connection / database switcher popover (Ctrl+Shift+K / Ctrl+Shift+D). */
export interface SwitcherState {
  tabId: string;
  mode: 'connection' | 'database';
  /** Anchor rectangle (viewport coordinates); centred under the top bar when absent. */
  anchor?: { left: number; top: number; bottom: number } | null;
}

const LAYOUT_KEY = 'dbstudio.layout.v1';

interface Layout {
  explorerWidth: number;
  /** Kept for M1 layouts; history now lives in the left dock. */
  historyWidth: number;
  /** Results pane height as a fraction of the console area. */
  resultsFraction: number;
  /** Left dock visible (Ctrl+B). */
  explorerVisible: boolean;
  historyVisible: boolean;
  resultsVisible: boolean;
  cellViewerWidth: number;
  dock: DockPanel;
}

export const DOCK_MIN = 220;
export const DOCK_MAX = 480;

const DEFAULT_LAYOUT: Layout = {
  explorerWidth: 280,
  historyWidth: 340,
  resultsFraction: 0.45,
  explorerVisible: true,
  historyVisible: false,
  resultsVisible: true,
  cellViewerWidth: 340,
  dock: 'explorer',
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const l = { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<Layout>) };
      l.explorerWidth = Math.max(DOCK_MIN, Math.min(DOCK_MAX, l.explorerWidth));
      if (!['explorer', 'history', 'connections'].includes(l.dock)) l.dock = 'explorer';
      return l;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

interface UiState extends Layout {
  paletteOpen: boolean;
  paletteMode: PaletteMode;
  /** Initial palette text (e.g. "t:" for tables). */
  paletteQuery: string;
  shortcutsOpen: boolean;
  settingsOpen: boolean;
  /** Tab whose title is being edited inline. */
  renamingTabId: string | null;
  switcher: SwitcherState | null;
  /** Multi-run dialog for a console tab (Ctrl+Alt+Enter). */
  multiRunFor: string | null;
  resultsMaximized: boolean;
  connectionDialog: ConnectionDialogState | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  cursor: { line: number; col: number } | null;
  wsStatus: WsStatus;
  engineError: string | null;
  /** Screen-reader announcement (aria-live region). */
  announcement: { id: number; text: string } | null;
  setLayout(p: Partial<Layout>): void;
  toggle(key: 'explorerVisible' | 'historyVisible' | 'resultsVisible'): void;
  /** Show a dock panel (opens the dock); `toggle` hides the dock when that panel is already showing. */
  showDock(panel: DockPanel, toggle?: boolean): void;
  openPalette(mode?: PaletteMode, query?: string): void;
  closePalette(): void;
  setShortcutsOpen(open: boolean): void;
  setSettingsOpen(open: boolean): void;
  setRenamingTab(id: string | null): void;
  openSwitcher(s: SwitcherState | null): void;
  openMultiRun(tabId: string | null): void;
  setResultsMaximized(v: boolean): void;
  openConnectionDialog(s: ConnectionDialogState): void;
  closeConnectionDialog(): void;
  askConfirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>;
  resolveConfirm(ok: boolean): void;
  toast(kind: Toast['kind'], text: string, detail?: string, action?: Toast['action']): void;
  dismissToast(id: number): void;
  setCursor(c: { line: number; col: number } | null): void;
  setWsStatus(s: WsStatus): void;
  setEngineError(e: string | null): void;
  announce(text: string): void;
}

let toastSeq = 0;
let announceSeq = 0;
let layoutTimer: ReturnType<typeof setTimeout> | null = null;

function persistLayout(s: Layout) {
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    const l: Layout = {
      explorerWidth: s.explorerWidth,
      historyWidth: s.historyWidth,
      resultsFraction: s.resultsFraction,
      explorerVisible: s.explorerVisible,
      historyVisible: s.historyVisible,
      resultsVisible: s.resultsVisible,
      cellViewerWidth: s.cellViewerWidth,
      dock: s.dock,
    };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    } catch {
      /* ignore */
    }
  }, 300);
}

export const useUi = create<UiState>((set, get) => ({
  ...loadLayout(),
  paletteOpen: false,
  paletteMode: 'commands',
  paletteQuery: '',
  shortcutsOpen: false,
  settingsOpen: false,
  renamingTabId: null,
  switcher: null,
  multiRunFor: null,
  resultsMaximized: false,
  connectionDialog: null,
  confirm: null,
  toasts: [],
  cursor: null,
  wsStatus: 'idle',
  engineError: null,
  announcement: null,
  setLayout(p) {
    set(p);
    persistLayout(get());
  },
  toggle(key) {
    if (key === 'historyVisible') {
      // M1 callers: history is a dock panel now.
      get().showDock('history', true);
      return;
    }
    set({ [key]: !get()[key] } as Partial<UiState>);
    if (key === 'resultsVisible' && !get().resultsVisible) set({ resultsMaximized: false });
    persistLayout(get());
  },
  showDock(panel, toggle = false) {
    const s = get();
    if (toggle && s.explorerVisible && s.dock === panel) set({ explorerVisible: false, historyVisible: false });
    else set({ explorerVisible: true, dock: panel, historyVisible: panel === 'history' });
    persistLayout(get());
  },
  openPalette(mode = 'commands', query = '') {
    set({ paletteOpen: true, paletteMode: mode, paletteQuery: query });
  },
  closePalette() {
    set({ paletteOpen: false });
  },
  setShortcutsOpen(open) {
    set({ shortcutsOpen: open });
  },
  setRenamingTab(id) {
    set({ renamingTabId: id });
  },
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },
  openSwitcher(s) {
    set({ switcher: s });
  },
  openMultiRun(tabId) {
    set({ multiRunFor: tabId });
  },
  setResultsMaximized(v) {
    set({ resultsMaximized: v, ...(v ? { resultsVisible: true } : {}) });
  },
  openConnectionDialog(s) {
    set({ connectionDialog: s });
  },
  closeConnectionDialog() {
    set({ connectionDialog: null });
  },
  askConfirm(req) {
    const prev = get().confirm;
    if (prev) prev.resolve(false);
    return new Promise<boolean>((resolve) => set({ confirm: { ...req, resolve } }));
  },
  resolveConfirm(ok) {
    const c = get().confirm;
    set({ confirm: null });
    c?.resolve(ok);
  },
  toast(kind, text, detail, action) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, text, detail, action }] });
    const ttl = kind === 'error' || action ? 8000 : 4000;
    setTimeout(() => get().dismissToast(id), ttl);
  },
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setCursor(c) {
    set({ cursor: c });
  },
  setWsStatus(s) {
    set({ wsStatus: s });
  },
  setEngineError(e) {
    set({ engineError: e });
  },
  announce(text) {
    set({ announcement: { id: ++announceSeq, text } });
  },
}));

export const toast = (kind: Toast['kind'], text: string, detail?: string, action?: Toast['action']) =>
  useUi.getState().toast(kind, text, detail, action);
