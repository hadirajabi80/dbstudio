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

export interface ConfirmAck {
  /** Checkbox label ("Allow this statement to write to “Prod”"). */
  label: string;
  /** true: the confirm button stays disabled until the box is ticked (explicit arming of a dangerous action). */
  required?: boolean;
}

export interface ConfirmResult {
  ok: boolean;
  /** State of the `ack` checkbox (false when there is none). */
  ack: boolean;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Optional list shown as bullet points (e.g. destructive statements found). */
  items?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger dialogs focus Cancel (Enter = Cancel) and style the confirm button as destructive. */
  danger?: boolean;
  /** Optional acknowledgement checkbox (read-only override, writes on read-only multi-run targets). */
  ack?: ConfirmAck;
  resolve: (r: ConfirmResult) => void;
  /** Set by askConfirmAck: every request is a fresh dialog (its checkbox starts unticked). */
  seq?: number;
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
  /** Dock width in px; 0 = automatic (see defaultDockWidth). */
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
  /** Results fraction chosen by the user per console tab (overrides `resultsFraction`). */
  tabSplits: Record<string, number>;
}

/** Dock width bounds: clamp(200px, 22vw, 480px). The default follows the window; a dragged width is kept. */
export const DOCK_MIN = 200;
export const DOCK_MAX = 480;

/** Default dock width for a window: 22vw within [DOCK_MIN, DOCK_MAX]. */
export function defaultDockWidth(viewport = typeof window === 'undefined' ? 1280 : window.innerWidth): number {
  return Math.round(Math.max(DOCK_MIN, Math.min(DOCK_MAX, viewport * 0.22)));
}

/** Windows shorter than this favour the results pane (40/60) after the first run. */
export const SHORT_WINDOW = 760;

const DEFAULT_LAYOUT: Layout = {
  // 0 = automatic: clamp(DOCK_MIN, 22vw, DOCK_MAX); a dragged width is stored in pixels.
  explorerWidth: 0,
  historyWidth: 340,
  resultsFraction: 0.45,
  explorerVisible: true,
  historyVisible: false,
  resultsVisible: true,
  cellViewerWidth: 340,
  dock: 'explorer',
  tabSplits: {},
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const l = { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<Layout>) };
      // 280 was the fixed M1 default (never dragged): treat it as automatic.
      l.explorerWidth = !l.explorerWidth || l.explorerWidth === 280 ? 0 : Math.max(DOCK_MIN, Math.min(DOCK_MAX, l.explorerWidth));
      if (!['explorer', 'history', 'connections'].includes(l.dock)) l.dock = 'explorer';
      if (!l.tabSplits || typeof l.tabSplits !== 'object') l.tabSplits = {};
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
  /** Cursor position per console tab (status bar "Ln, Col"). */
  cursors: Record<string, { line: number; col: number }>;
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
  /** Like askConfirm, also returning the state of the `ack` checkbox. */
  askConfirmAck(req: Omit<ConfirmRequest, 'resolve'>): Promise<ConfirmResult>;
  resolveConfirm(ok: boolean, ack?: boolean): void;
  toast(kind: Toast['kind'], text: string, detail?: string, action?: Toast['action']): void;
  dismissToast(id: number): void;
  setCursor(tabId: string, c: { line: number; col: number } | null): void;
  /** Remember the results/editor split of one console tab (null forgets it). */
  setTabSplit(tabId: string, fraction: number | null): void;
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
      // Bounded: only the most recent tabs are kept.
      tabSplits: Object.fromEntries(Object.entries(s.tabSplits).slice(-100)),
    };
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
    } catch {
      /* ignore */
    }
  }, 300);
}

let confirmSeq = 0;

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
  cursors: {},
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
    return get().askConfirmAck(req).then((r) => r.ok);
  },
  askConfirmAck(req) {
    const prev = get().confirm;
    if (prev) prev.resolve({ ok: false, ack: false });
    return new Promise<ConfirmResult>((resolve) => set({ confirm: { ...req, resolve, seq: ++confirmSeq } }));
  },
  resolveConfirm(ok, ack = false) {
    const c = get().confirm;
    set({ confirm: null });
    // A required acknowledgement that was not ticked never confirms.
    c?.resolve({ ok: ok && (!c.ack?.required || ack), ack: !!c.ack && ack });
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
  setCursor(tabId, c) {
    const cur = get().cursors[tabId];
    if (c && cur && cur.line === c.line && cur.col === c.col) return;
    const cursors = { ...get().cursors };
    if (c) cursors[tabId] = c;
    else delete cursors[tabId];
    set({ cursors });
  },
  setTabSplit(tabId, fraction) {
    const tabSplits = { ...get().tabSplits };
    if (fraction === null) delete tabSplits[tabId];
    else tabSplits[tabId] = fraction;
    set({ tabSplits });
    persistLayout(get());
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
