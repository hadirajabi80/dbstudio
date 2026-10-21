// Detached tab windows, electron-free (unit tested in test/windows.test.mjs with fake windows):
//  - payload validation for the `// ---- windows` IPC channels,
//  - the registry of detached windows and the tabs each shows, which keeps the main window informed so the tabs are
//    saved in its workspace (and come back there after a restart) and hands tabs back when asked or when the user
//    closes a detached window.
import { IPC } from '../shared/channels';
import { ValidationError } from './validate';

/** Re-exported: every out/lib bundle inlines its own copy of validate.ts. */
export { ValidationError };

export const WINDOW_LIMITS = {
  /** Tabs moved in one call / shown in one detached window. */
  tabs: 50,
  /** Open detached windows. */
  windows: 20,
  /** Serialized size of the tabs of one call (UTF-16 code units): consoles carry their text. */
  payloadChars: 32 * 1024 * 1024,
  idLength: 128,
  titleLength: 300,
} as const;

const TAB_KINDS = new Set(['console', 'object', 'view']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Serialized workspace tabs (ui/src/store/tabs.ts Tab): plain JSON objects with an id, a known kind and a title.
 * Returns a JSON round-tripped copy (no prototypes, functions or cycles survive).
 */
export function validateTabs(v: unknown): Record<string, unknown>[] {
  if (!Array.isArray(v)) throw new ValidationError('tabs must be an array');
  if (v.length > WINDOW_LIMITS.tabs) throw new ValidationError('too many tabs');
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    throw new ValidationError('tabs are not JSON-serializable');
  }
  if (json.length > WINDOW_LIMITS.payloadChars) throw new ValidationError('tabs are too large');
  const tabs = JSON.parse(json) as unknown[];
  const ids = new Set<string>();
  return tabs.map((t, i) => {
    if (!isPlainObject(t)) throw new ValidationError(`tabs[${i}] must be an object`);
    if (typeof t.id !== 'string' || !t.id || t.id.length > WINDOW_LIMITS.idLength || !/^[\w.:-]+$/.test(t.id)) throw new ValidationError(`tabs[${i}].id is invalid`);
    if (ids.has(t.id)) throw new ValidationError(`tabs[${i}].id is a duplicate`);
    ids.add(t.id);
    if (typeof t.kind !== 'string' || !TAB_KINDS.has(t.kind)) throw new ValidationError(`tabs[${i}].kind is invalid`);
    if (typeof t.title !== 'string' || t.title.length > WINDOW_LIMITS.titleLength) throw new ValidationError(`tabs[${i}].title is invalid`);
    if (t.kind === 'view' && typeof t.view !== 'string') throw new ValidationError(`tabs[${i}].view must be a string`);
    return t;
  });
}

export interface OpenTabWindowArgs {
  tabs: Record<string, unknown>[];
  /** Screen position (e.g. where a tab was dropped), rounded. */
  position?: { x: number; y: number };
}

export function validateOpenTabWindowArgs(v: unknown): OpenTabWindowArgs {
  if (!isPlainObject(v)) throw new ValidationError('options must be an object');
  const tabs = validateTabs(v.tabs);
  if (tabs.length === 0) throw new ValidationError('tabs must not be empty');
  let position: OpenTabWindowArgs['position'];
  if (v.position !== undefined && v.position !== null) {
    const p = v.position;
    if (!isPlainObject(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new ValidationError('position must be { x, y } numbers');
    }
    const clamp = (n: number) => Math.round(Math.max(-100_000, Math.min(100_000, n)));
    position = { x: clamp(p.x), y: clamp(p.y) };
  }
  return { tabs, ...(position ? { position } : {}) };
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Bounds of a detached window: a comfortable size near `position` (a dropped tab lands roughly under the pointer), or
 * offset from the main window, kept inside the display's work area.
 */
export function secondaryWindowBounds(position: { x: number; y: number } | undefined, area: Bounds, main?: Bounds): Bounds {
  const width = Math.min(1100, Math.max(640, area.width - 80));
  const height = Math.min(760, Math.max(420, area.height - 80));
  const want = position ? { x: position.x - 160, y: position.y - 60 } : main ? { x: main.x + 48, y: main.y + 48 } : { x: area.x + 40, y: area.y + 40 };
  const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - width, want.x)));
  const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, want.y)));
  return { x, y, width, height };
}

/** What the registry needs from a BrowserWindow. */
export interface WindowLike {
  isDestroyed(): boolean;
  close(): void;
  focus(): void;
  once(event: 'closed', listener: () => void): unknown;
  webContents: { id: number; send(channel: string, ...args: unknown[]): void };
}

export interface DetachedWindowsDeps<W extends WindowLike> {
  /** Creates (and loads) a detached window. */
  create(opts: { position?: { x: number; y: number } }): W;
  /** The main window, if open. */
  primary(): W | null;
}

interface Entry<W> {
  win: W;
  tabs: Record<string, unknown>[];
  /** Set when the window closes because its tabs were handed back (nothing to report as closed). */
  emptied: boolean;
}

/** The detached windows of the app, keyed by their webContents id. */
export class DetachedWindows<W extends WindowLike> {
  private readonly entries = new Map<number, Entry<W>>();
  private shuttingDown = false;

  constructor(private readonly deps: DetachedWindowsDeps<W>) {}

  get size(): number {
    return this.entries.size;
  }

  isDetached(webContentsId: number): boolean {
    return this.entries.has(webContentsId);
  }

  /** Opens a window showing `tabs`; false when too many windows are open. */
  open(args: OpenTabWindowArgs): boolean {
    if (this.shuttingDown || this.entries.size >= WINDOW_LIMITS.windows) return false;
    const win = this.deps.create({ position: args.position });
    const id = win.webContents.id;
    this.entries.set(id, { win, tabs: args.tabs, emptied: false });
    win.once('closed', () => this.onClosed(id));
    this.broadcast();
    return true;
  }

  /** The tabs a detached window shows (null for any other window). */
  tabsOf(webContentsId: number): Record<string, unknown>[] | null {
    return this.entries.get(webContentsId)?.tabs ?? null;
  }

  /** A detached window reported its tabs (debounced by the renderer). */
  update(webContentsId: number, tabs: Record<string, unknown>[]): void {
    const e = this.entries.get(webContentsId);
    if (!e) return;
    e.tabs = tabs;
    this.broadcast();
  }

  /** Hands tabs from a detached window to the main window; false (nothing sent) when the main window is gone. */
  reattach(webContentsId: number, tabs: Record<string, unknown>[]): boolean {
    const e = this.entries.get(webContentsId);
    const main = this.livePrimary();
    if (!e || !main) return false;
    const moved = new Set(tabs.map((t) => t.id));
    e.tabs = e.tabs.filter((t) => !moved.has(t.id));
    main.webContents.send(IPC.tabsReattached, { tabs, closed: false });
    main.focus();
    this.broadcast();
    return true;
  }

  /** A detached window without tabs closes. */
  closeEmpty(webContentsId: number): void {
    const e = this.entries.get(webContentsId);
    if (!e) return;
    e.emptied = true;
    e.tabs = [];
    if (!e.win.isDestroyed()) e.win.close();
  }

  /**
   * The main window closed or the app quits: detached windows close with it. Their tabs are already in the main
   * window's workspace (`detached`), so they are not reported as closed: they come back on the next start.
   */
  closeAll(): void {
    if (this.entries.size === 0) return;
    this.shuttingDown = true;
    for (const e of [...this.entries.values()]) if (!e.win.isDestroyed()) e.win.close();
  }

  /** Every tab of every detached window (for the main window's workspace). */
  allTabs(): Record<string, unknown>[] {
    return [...this.entries.values()].flatMap((e) => e.tabs);
  }

  private onClosed(webContentsId: number): void {
    const e = this.entries.get(webContentsId);
    if (!e) return;
    this.entries.delete(webContentsId);
    if (this.shuttingDown) {
      // macOS keeps running without windows: a new main window may detach tabs again.
      if (this.entries.size === 0) this.shuttingDown = false;
      return;
    }
    // Closed by the user with tabs still in it: the main window keeps them as recently closed (Ctrl+Shift+T).
    const main = this.livePrimary();
    if (!e.emptied && e.tabs.length && main) main.webContents.send(IPC.tabsReattached, { tabs: e.tabs, closed: true });
    this.broadcast();
  }

  private livePrimary(): W | null {
    const p = this.deps.primary();
    return p && !p.isDestroyed() ? p : null;
  }

  private broadcast(): void {
    this.livePrimary()?.webContents.send(IPC.detachedTabs, this.allTabs());
  }
}
