import { create } from 'zustand';
import type { ProviderId } from '../api/types';
import type { WsStatus } from '../api/ws';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'warning' | 'error';
  text: string;
  detail?: string;
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
  | { mode: 'new'; providerId?: ProviderId; folder?: string | null }
  | { mode: 'edit'; id: string }
  | { mode: 'duplicate'; id: string };

const LAYOUT_KEY = 'dbstudio.layout.v1';

interface Layout {
  explorerWidth: number;
  historyWidth: number;
  /** Results pane height as a fraction of the console area. */
  resultsFraction: number;
  explorerVisible: boolean;
  historyVisible: boolean;
  resultsVisible: boolean;
  cellViewerWidth: number;
}

const DEFAULT_LAYOUT: Layout = {
  explorerWidth: 280,
  historyWidth: 340,
  resultsFraction: 0.45,
  explorerVisible: true,
  historyVisible: false,
  resultsVisible: true,
  cellViewerWidth: 340,
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<Layout>) };
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

interface UiState extends Layout {
  paletteOpen: boolean;
  paletteMode: 'commands' | 'objects';
  connectionDialog: ConnectionDialogState | null;
  confirm: ConfirmRequest | null;
  toasts: Toast[];
  cursor: { line: number; col: number } | null;
  wsStatus: WsStatus;
  engineError: string | null;
  setLayout(p: Partial<Layout>): void;
  toggle(key: 'explorerVisible' | 'historyVisible' | 'resultsVisible'): void;
  openPalette(mode?: 'commands' | 'objects'): void;
  closePalette(): void;
  openConnectionDialog(s: ConnectionDialogState): void;
  closeConnectionDialog(): void;
  askConfirm(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean>;
  resolveConfirm(ok: boolean): void;
  toast(kind: Toast['kind'], text: string, detail?: string): void;
  dismissToast(id: number): void;
  setCursor(c: { line: number; col: number } | null): void;
  setWsStatus(s: WsStatus): void;
  setEngineError(e: string | null): void;
}

let toastSeq = 0;
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
  connectionDialog: null,
  confirm: null,
  toasts: [],
  cursor: null,
  wsStatus: 'idle',
  engineError: null,
  setLayout(p) {
    set(p);
    persistLayout(get());
  },
  toggle(key) {
    set({ [key]: !get()[key] } as Partial<UiState>);
    persistLayout(get());
  },
  openPalette(mode = 'commands') {
    set({ paletteOpen: true, paletteMode: mode });
  },
  closePalette() {
    set({ paletteOpen: false });
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
  toast(kind, text, detail) {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-4), { id, kind, text, detail }] });
    const ttl = kind === 'error' ? 8000 : 4000;
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
}));

export const toast = (kind: Toast['kind'], text: string, detail?: string) => useUi.getState().toast(kind, text, detail);
