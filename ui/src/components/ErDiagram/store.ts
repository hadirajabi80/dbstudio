// Per-tab ER diagram controller: the diagram state (positions, hidden/added/pinned tables, view options, selection,
// viewport), derived model + geometry, auto layout through the worker, and the debounced (800 ms) layout save
// (docs/PLAN-M2.md section 3). Framework-free (a vanilla zustand store); the React views subscribe to it and the
// er.* commands drive the controller of the active tab (./controllers.ts).
import { createStore, type StoreApi } from 'zustand/vanilla';
import { api, errorMessage } from '../../api/client';
import { layoutScopeKey } from '../../api/er';
import type { CatalogSchema, DiagramAutoLayout, DiagramLayout, DiagramScope, DiagramViewOptions } from '../../api/types';
import { diagramBounds, routeEdges, type EdgeGeom, type Rect } from './edges';
import { buildModel, CARD, geometryOf, readingOrder, type CardGeom, type DiagramModel, type ErNode } from './model';
import { placeNew } from './place';
import type { SyntheticSpec } from './synthetic';
import { centerOn, clampZoom, fitTransform, stepZoom, worldViewport, zoomAt, type Transform } from './viewport';

export { ER_VIEW_ID as ER_VIEW } from './controllers';
export const SAVE_DEBOUNCE_MS = 800;

/** `tab.state` of an ER tab (JSON; no live handles). */
export interface ErTabState {
  connectionId: string;
  /** Catalog database key (`catalogDatabase`). */
  database: string | null;
  scope: DiagramScope;
  /** Dev/QA: a generated catalog instead of the connection's (never saved). */
  synthetic?: SyntheticSpec | null;
}

export type ViewOptions = Required<DiagramViewOptions>;
export const DEFAULT_OPTIONS: ViewOptions = { columns: 'all', types: true, onlyConnected: false, hideViews: false, details: true };

export type SaveState = 'off' | 'idle' | 'pending' | 'saving' | 'saved' | 'error';
export type Phase = 'loading' | 'layout' | 'ready' | 'error';

/** Drag-to-create FK request (column of A dropped on a column of B), or the keyboard command's empty draft. */
export interface FkDraft {
  from: string;
  fromColumn: string | null;
  to: string | null;
  toColumn: string | null;
}

export interface ErState {
  connectionId: string;
  database: string | null;
  scope: DiagramScope;
  synthetic: SyntheticSpec | null;
  phase: Phase;
  progress: string | null;
  error: string | null;
  layoutId: string | null;
  positions: Record<string, [number, number]>;
  hidden: string[];
  added: string[];
  pinned: string[];
  options: ViewOptions;
  auto: DiagramAutoLayout;
  expanded: string[];
  selection: string[];
  focusKey: string | null;
  transform: Transform;
  /** Bumped on programmatic viewport changes (the canvas applies them to the DOM). */
  transformSeq: number;
  viewSize: { w: number; h: number };
  search: string;
  /** Index into the current matches (Enter / Shift+Enter in the search box). */
  searchHit: number;
  searchFocusSeq: number;
  pulse: { key: string; seq: number } | null;
  save: SaveState;
  saveError: string | null;
  model: DiagramModel | null;
  geom: Map<string, CardGeom>;
  edges: Map<string, EdgeGeom>;
  addOpen: boolean;
  fkDraft: FkDraft | null;
  /** Catalog inputs (not persisted). */
  schemas: readonly CatalogSchema[];
  defaultSchema: string | null;
}

const uid = () => `er_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export class ErController {
  readonly tabId: string;
  readonly store: StoreApi<ErState>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private loadedLayout = false;
  private layoutRun = 0;
  private disposed = false;
  /** Set by the canvas: DOM focus of a card after keyboard navigation. */
  focusDom: ((key: string) => void) | null = null;
  /** Set by the view: focus the search box. */
  focusSearchDom: (() => void) | null = null;

  constructor(tabId: string, tab: ErTabState) {
    this.tabId = tabId;
    this.store = createStore<ErState>(() => ({
      connectionId: tab.connectionId, database: tab.database, scope: tab.scope, synthetic: tab.synthetic ?? null,
      phase: 'loading', progress: null, error: null, layoutId: null,
      positions: {}, hidden: [], added: [], pinned: [], options: { ...DEFAULT_OPTIONS }, auto: 'layered-lr', expanded: [],
      selection: [], focusKey: null, transform: { x: 0, y: 0, k: 1 }, transformSeq: 0, viewSize: { w: 0, h: 0 },
      search: '', searchHit: 0, searchFocusSeq: 0, pulse: null, save: tab.synthetic ? 'off' : 'idle', saveError: null,
      model: null, geom: new Map(), edges: new Map(), addOpen: false, fkDraft: null, schemas: [], defaultSchema: null,
    }));
  }

  get state(): ErState {
    return this.store.getState();
  }

  private set(p: Partial<ErState>) {
    if (!this.disposed) this.store.setState(p);
  }

  /** Mounted (again: React StrictMode unmounts and remounts once in development). */
  attach(): void {
    this.disposed = false;
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.flushSave();
    }
    this.disposed = true;
  }

  get scopeKey(): string {
    return layoutScopeKey(this.state.scope);
  }

  // ------------------------------------------------------------ model

  /** New catalog data (the loaded schemas of the connection/database). */
  setCatalog(schemas: readonly CatalogSchema[], defaultSchema: string | null): void {
    this.set({ schemas, defaultSchema });
    this.rebuild();
  }

  /** Recomputes model, geometry and edge routes; gives new cards a position once the diagram is laid out. */
  rebuild(): void {
    const s = this.state;
    const model = buildModel({
      schemas: s.schemas, defaultSchema: s.defaultSchema, scope: s.scope, added: s.added, hidden: s.hidden,
      hideViews: s.options.hideViews, onlyConnected: s.options.onlyConnected,
    });
    const geom = geometryOf(model, { columns: s.options.columns, types: s.options.types, expanded: new Set(s.expanded) });
    let positions = s.positions;
    if (s.phase === 'ready') {
      const missing = model.nodes.filter((n) => !positions[n.key]);
      if (missing.length) {
        positions = { ...positions, ...this.placeMissing(missing, model, geom, positions) };
        this.scheduleSave();
      }
    }
    const keys = new Set(model.nodes.map((n) => n.key));
    this.set({
      model, geom, positions, edges: routeEdges(model, positions, geom),
      selection: s.selection.filter((k) => keys.has(k)), focusKey: s.focusKey && keys.has(s.focusKey) ? s.focusKey : null,
    });
  }

  /** Ghosts go next to the card they connect to; other new tables in a grid below the diagram. */
  private placeMissing(missing: ErNode[], model: DiagramModel, geom: Map<string, CardGeom>, positions: Record<string, [number, number]>) {
    const out: Record<string, [number, number]> = {};
    const rest: ErNode[] = [];
    for (const n of missing) {
      const e = n.ghost ? model.edges.find((x) => (x.from === n.key && positions[x.to]) || (x.to === n.key && positions[x.from])) : undefined;
      const anchorKey = e ? (e.from === n.key ? e.to : e.from) : null;
      const anchor = anchorKey ? positions[anchorKey] : null;
      if (anchor && anchorKey) {
        const ag = geom.get(anchorKey)!;
        const g = geom.get(n.key)!;
        let y = anchor[1];
        const x = e!.from === n.key ? anchor[0] + ag.w + 120 : anchor[0] - g.w - 120;
        // step down past other cards already there
        const taken = (yy: number) => Object.entries({ ...positions, ...out }).some(([k, p]) => {
          const gg = geom.get(k);
          return gg && p[0] < x + g.w && x < p[0] + gg.w && p[1] < yy + g.h && yy < p[1] + gg.h;
        });
        let guard = 0;
        while (taken(y) && guard++ < 50) y += CARD.headerH + 24;
        out[n.key] = [Math.round(x), Math.round(y)];
      } else rest.push(n);
    }
    Object.assign(out, placeNew({ ...positions, ...out }, rest.map((n) => ({ key: n.key, w: geom.get(n.key)!.w, h: geom.get(n.key)!.h })), (k) => geom.get(k)));
    return out;
  }

  private reroute(positions = this.state.positions): void {
    const s = this.state;
    if (s.model) this.set({ positions, edges: routeEdges(s.model, positions, s.geom) });
  }

  // ------------------------------------------------------------ load / layout

  /** First load: the saved layout (if any), else an auto layout. Call once the catalog for the scope is loaded. */
  async start(): Promise<void> {
    if (this.loadedLayout) return;
    this.loadedLayout = true;
    const s = this.state;
    let saved: DiagramLayout | undefined;
    if (!s.synthetic) {
      try {
        const list = await api.er.layouts(s.connectionId, { database: s.database ?? '', scope: this.scopeKey });
        saved = list.find((l) => layoutScopeKey(l.scope) === this.scopeKey) ?? list[0];
      } catch (e) {
        console.warn('[er] could not load the saved layout', e);
      }
    }
    if (saved) {
      this.set({
        layoutId: saved.id, positions: { ...saved.positions }, hidden: saved.hidden ?? [], added: saved.added ?? [], pinned: saved.pinned ?? [],
        auto: saved.auto ?? 'layered-lr', options: { ...DEFAULT_OPTIONS, ...(saved.options ?? {}) }, save: 'saved',
      });
      this.rebuild();
      const model = this.state.model;
      const placed = model ? model.nodes.filter((n) => !n.ghost && saved!.positions[n.key]).length : 0;
      if (model && placed === 0 && model.memberCount > 0) {
        await this.relayout(this.state.auto, { fit: true, save: false });
        return;
      }
      this.set({ phase: 'ready' });
      this.rebuild(); // places tables added since the layout was saved
      const t = Number.isFinite(saved.zoom) && saved.pan ? { k: clampZoom(saved.zoom), x: saved.pan[0], y: saved.pan[1] } : null;
      if (t) this.setTransform(t, false);
      else this.fit();
      return;
    }
    this.rebuild();
    await this.relayout(this.state.auto, { fit: true, save: false });
  }

  /** Runs an auto layout over every card (pinned cards stay). */
  async relayout(mode: DiagramAutoLayout = this.state.auto, opts: { fit?: boolean; save?: boolean } = {}): Promise<void> {
    const s = this.state;
    if (!s.model) return;
    const run = ++this.layoutRun;
    const n = s.model.nodes.length;
    this.set({ phase: s.phase === 'ready' ? 'ready' : 'layout', progress: n ? `Laying out ${n} tables…` : null, auto: mode });
    const pinned: Record<string, [number, number]> = {};
    for (const k of s.pinned) if (s.positions[k]) pinned[k] = s.positions[k];
    try {
      const { runLayout } = await import('./layoutRunner');
      const r = await runLayout({
        nodes: s.model.nodes.map((x) => ({ key: x.key, w: s.geom.get(x.key)!.w, h: s.geom.get(x.key)!.h, schema: x.schema })),
        edges: s.model.edges.map((e) => ({ from: e.from, to: e.to })),
        mode, pinned,
      }, (msg) => run === this.layoutRun && this.set({ progress: msg }));
      if (run !== this.layoutRun || this.disposed) return;
      this.set({ phase: 'ready', progress: null });
      this.reroute(r.positions);
      if (opts.fit !== false) this.fit();
      if (opts.save !== false || this.state.layoutId) this.scheduleSave();
    } catch (e) {
      if (run !== this.layoutRun) return;
      this.set({ phase: 'error', progress: null, error: `Layout failed: ${errorMessage(e)}` });
    }
  }

  /** "Reset layout": forget manual positions and pins, lay out again. */
  async resetLayout(): Promise<void> {
    this.set({ pinned: [], positions: {} });
    await this.relayout(this.state.auto, { fit: true, save: true });
  }

  // ------------------------------------------------------------ editing

  moveTo(patch: Record<string, [number, number]>, save = true): void {
    const positions = { ...this.state.positions };
    for (const [k, p] of Object.entries(patch)) positions[k] = [Math.round(p[0]), Math.round(p[1])];
    this.reroute(positions);
    if (save) this.scheduleSave();
  }

  moveSelection(dx: number, dy: number): void {
    const s = this.state;
    const keys = s.selection.length ? s.selection : s.focusKey ? [s.focusKey] : [];
    if (!keys.length) return;
    const patch: Record<string, [number, number]> = {};
    for (const k of keys) if (s.positions[k]) patch[k] = [s.positions[k][0] + dx, s.positions[k][1] + dy];
    this.moveTo(patch);
  }

  /** Removes tables from the diagram (not from the database). */
  remove(keys: readonly string[]): void {
    if (!keys.length) return;
    const s = this.state;
    const ks = new Set(keys);
    this.set({
      hidden: [...new Set([...s.hidden, ...keys])], added: s.added.filter((k) => !ks.has(k)),
      selection: s.selection.filter((k) => !ks.has(k)), focusKey: s.focusKey && ks.has(s.focusKey) ? null : s.focusKey,
    });
    this.rebuild();
    this.scheduleSave();
  }

  /** Adds tables (ghost click, "Add tables…", "Show related"). */
  add(keys: readonly string[]): void {
    if (!keys.length) return;
    const s = this.state;
    const ks = new Set(keys);
    this.set({ hidden: s.hidden.filter((k) => !ks.has(k)), added: [...new Set([...s.added, ...keys])] });
    this.rebuild();
    this.scheduleSave();
  }

  /** Adds every table one FK hop away from `key` (ghost neighbours become members). */
  showRelated(key: string): void {
    const s = this.state;
    if (!s.model) return;
    const hop = s.model.edges.filter((e) => e.from === key || e.to === key).map((e) => (e.from === key ? e.to : e.from));
    const n = s.model.byKey.get(key);
    if (n?.ghost) hop.push(key);
    // hidden neighbours come back too
    const hiddenHop: string[] = [];
    for (const sc of s.schemas) {
      for (const o of sc.objects) {
        const k = `${sc.name}.${o.n}`;
        if (!s.hidden.includes(k)) continue;
        if ((o.fk ?? []).some((f) => `${f.rs ?? sc.name}.${f.rt}` === key) || (n?.fks ?? []).some((f) => `${f.rs ?? n!.schema}.${f.rt}` === k)) hiddenHop.push(k);
      }
    }
    this.add([...new Set([...hop, ...hiddenHop])].filter((k) => k !== key || n?.ghost));
  }

  togglePin(key: string): void {
    const s = this.state;
    this.set({ pinned: s.pinned.includes(key) ? s.pinned.filter((k) => k !== key) : [...s.pinned, key] });
    this.scheduleSave();
  }

  toggleExpanded(key: string): void {
    const s = this.state;
    this.set({ expanded: s.expanded.includes(key) ? s.expanded.filter((k) => k !== key) : [...s.expanded, key] });
    this.rebuild();
  }

  setOption<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]): void {
    const s = this.state;
    if (s.options[key] === value) return;
    this.set({ options: { ...s.options, [key]: value } });
    if (key !== 'details') this.rebuild();
    this.scheduleSave();
  }

  /** New scope (toolbar schema switch): a different saved layout. */
  setScope(scope: DiagramScope): void {
    this.flushPending();
    this.loadedLayout = false;
    this.set({
      scope, layoutId: null, positions: {}, hidden: [], added: [], pinned: [], expanded: [], selection: [], focusKey: null,
      phase: 'loading', save: this.state.synthetic ? 'off' : 'idle',
    });
    this.rebuild();
  }

  // ------------------------------------------------------------ selection / focus

  select(keys: readonly string[], mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
    const s = this.state;
    let next: string[];
    if (mode === 'replace') next = [...keys];
    else if (mode === 'add') next = [...new Set([...s.selection, ...keys])];
    else {
      const cur = new Set(s.selection);
      for (const k of keys) {
        if (cur.has(k)) cur.delete(k);
        else cur.add(k);
      }
      next = [...cur];
    }
    if (!same(next, s.selection)) this.set({ selection: next });
    if (keys.length === 1) this.set({ focusKey: keys[0] });
  }

  selectAll(): void {
    const m = this.state.model;
    if (m) this.set({ selection: m.nodes.filter((n) => !n.ghost).map((n) => n.key) });
  }

  /** Cards in reading order (Tab / Shift+Tab). */
  order(): string[] {
    const s = this.state;
    return s.model ? readingOrder(s.model.nodes.map((n) => n.key), s.positions, s.geom) : [];
  }

  /** Key Tab / Shift+Tab moves to, or null at the end (focus then leaves the canvas). */
  nextKey(dir: 1 | -1): string | null {
    const order = this.order();
    if (!order.length) return null;
    const cur = this.state.focusKey;
    const i = cur ? order.indexOf(cur) : -1;
    if (i < 0) return dir > 0 ? order[0] : order[order.length - 1];
    const j = i + dir;
    return j >= 0 && j < order.length ? order[j] : null;
  }

  focusCard(key: string, opts: { reveal?: boolean; select?: boolean; dom?: boolean } = {}): void {
    this.set({ focusKey: key });
    if (opts.select !== false) this.select([key]);
    if (opts.reveal !== false) this.reveal(key);
    if (opts.dom !== false) this.focusDom?.(key);
  }

  /** Target card of a command: explicit key, else the focused card, else a single selection. */
  targetKey(key?: string | null): string | null {
    if (key) return key;
    const s = this.state;
    return s.focusKey ?? (s.selection.length === 1 ? s.selection[0] : null);
  }

  // ------------------------------------------------------------ viewport

  setViewSize(w: number, h: number): void {
    const s = this.state;
    if (s.viewSize.w !== w || s.viewSize.h !== h) this.set({ viewSize: { w, h } });
  }

  /** Programmatic viewport change (the canvas applies it). */
  setTransform(t: Transform, save = true): void {
    this.set({ transform: { x: t.x, y: t.y, k: clampZoom(t.k) }, transformSeq: this.state.transformSeq + 1 });
    if (save) this.scheduleSave();
  }

  /** The canvas committed a user pan/zoom (already on screen). */
  commitTransform(t: Transform): void {
    const c = this.state.transform;
    if (c.x === t.x && c.y === t.y && c.k === t.k) return;
    this.set({ transform: { ...t } });
    this.scheduleSave();
  }

  bounds(keys?: Iterable<string>): Rect | null {
    const s = this.state;
    return diagramBounds(s.positions, s.geom, keys);
  }

  fit(): void {
    const s = this.state;
    this.setTransform(fitTransform(this.bounds(), s.viewSize.w, s.viewSize.h));
  }

  zoomStep(dir: 1 | -1): void {
    const s = this.state;
    const t = s.transform;
    this.setTransform(zoomAt(t, stepZoom(t.k, dir), s.viewSize.w / 2, s.viewSize.h / 2));
  }

  zoomTo(k: number): void {
    const s = this.state;
    this.setTransform(zoomAt(s.transform, k, s.viewSize.w / 2, s.viewSize.h / 2));
  }

  /** Pans (and zooms in to at least 60 % when the cards would be unreadable) so a card is fully visible. */
  reveal(key: string, opts: { center?: boolean; minZoom?: number } = {}): void {
    const s = this.state;
    const p = s.positions[key];
    const g = s.geom.get(key);
    if (!p || !g || !s.viewSize.w) return;
    const k = Math.max(s.transform.k, opts.minZoom ?? 0);
    const view = worldViewport({ ...s.transform, k }, s.viewSize.w, s.viewSize.h);
    const inside = p[0] >= view.x + 16 / k && p[1] >= view.y + 16 / k && p[0] + g.w <= view.x + view.w - 16 / k && p[1] + Math.min(g.h, 200) <= view.y + view.h - 16 / k;
    if (inside && !opts.center && k === s.transform.k) return;
    this.setTransform(centerOn(p[0] + g.w / 2, p[1] + Math.min(g.h, view.h * 0.8) / 2, s.viewSize.w, s.viewSize.h, k));
  }

  // ------------------------------------------------------------ search

  matches(query = this.state.search): string[] {
    const q = query.trim().toLowerCase();
    const s = this.state;
    if (!q || !s.model) return [];
    const order = this.order();
    const rank = new Map(order.map((k, i) => [k, i]));
    const byName = s.model.nodes.filter((n) => n.name.toLowerCase().includes(q) || n.label.toLowerCase().includes(q));
    const byColumn = s.model.nodes.filter((n) => !byName.includes(n) && n.columns.some((c) => c.name.toLowerCase().includes(q)));
    const sort = (a: ErNode, b: ErNode) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0);
    return [...byName.sort(sort), ...byColumn.sort(sort)].map((n) => n.key);
  }

  setSearch(q: string): void {
    this.set({ search: q, searchHit: 0 });
  }

  /** Zooms to and pulses the next (dir 1) / previous match. */
  searchStep(dir: 1 | -1 = 1): string | null {
    const m = this.matches();
    if (!m.length) return null;
    const s = this.state;
    const cur = s.pulse && m.includes(s.pulse.key) ? m.indexOf(s.pulse.key) : -1;
    const i = cur < 0 ? (dir > 0 ? 0 : m.length - 1) : (cur + dir + m.length) % m.length;
    const key = m[i];
    this.set({ searchHit: i, pulse: { key, seq: (s.pulse?.seq ?? 0) + 1 }, focusKey: key, selection: [key] });
    this.reveal(key, { center: true, minZoom: 0.75 });
    return key;
  }

  requestSearchFocus(): void {
    this.set({ searchFocusSeq: this.state.searchFocusSeq + 1 });
    this.focusSearchDom?.();
  }

  setAddOpen(open: boolean): void {
    this.set({ addOpen: open });
  }

  setFkDraft(d: FkDraft | null): void {
    this.set({ fkDraft: d });
  }

  // ------------------------------------------------------------ persistence

  layoutBody(): DiagramLayout | null {
    const s = this.state;
    if (s.synthetic) return null;
    const keep = new Set(s.model?.nodes.map((n) => n.key) ?? []);
    const positions: Record<string, [number, number]> = {};
    for (const [k, p] of Object.entries(s.positions)) if (keep.has(k)) positions[k] = p;
    return {
      id: s.layoutId ?? uid(), scope: s.scope, positions, hidden: s.hidden, added: s.added, pinned: s.pinned,
      zoom: s.transform.k, pan: [Math.round(s.transform.x), Math.round(s.transform.y)], updatedAt: new Date().toISOString(),
      auto: s.auto, options: s.options,
    };
  }

  scheduleSave(): void {
    const s = this.state;
    if (s.synthetic || s.phase !== 'ready') return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.set({ save: 'pending' });
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  private flushPending(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    void this.flushSave();
  }

  async flushSave(): Promise<void> {
    const body = this.layoutBody();
    if (!body) return;
    const cid = this.state.connectionId;
    if (!this.state.layoutId) this.set({ layoutId: body.id });
    this.set({ save: 'saving' });
    try {
      await api.er.saveLayout(cid, body);
      if (!this.saveTimer) this.set({ save: 'saved', saveError: null });
    } catch (e) {
      this.set({ save: 'error', saveError: errorMessage(e) });
    }
  }
}
