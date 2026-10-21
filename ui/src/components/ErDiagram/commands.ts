// M2-ER commands (auto-loaded by commands/index.ts; docs/PLAN-M2.md section 3) and the ER tab view registration.
//   er.open          Ctrl+Alt+E  explorer connection / database / schema, or the active tab's context → schema diagram
//   er.openRelated               explorer table → the table + every table within one FK hop
//   er.openSelected              explorer multi-selection → diagram of those tables
// In the diagram (scope `er`: the whole view; `er-canvas`: the canvas, which has no text fields):
//   Ctrl+F search · F fit · 0 100 % · = / - zoom · Ctrl+A select all · arrows move 8 px · Delete removes from the
//   diagram · Enter opens data · F4 design · Tab / Shift+Tab next / previous card · Shift+F10 card menu · Esc deselect
// The view itself is lazy (./views.tsx), so this module stays small.
import { errorMessage } from '../../api/client';
import { copyText } from '../../app/actions';
import { objectTargetOf } from '../../commands/core';
import { registerCommands, runCommand, type Command } from '../../commands/registry';
import { getPlatform } from '../../platform';
import { dialectOf } from '../../store/connections';
import { toast } from '../../store/ui';
import { showContextMenu } from '../common/Menu';
import { commandMenuItems } from '../layout/commandMenu';
import { registerTabView } from '../layout/tabViews';
import { activeController, cardTarget, cssEscape, ER_VIEW_ID, fkUnavailableReason } from './controllers';
import { ER_CARD_MENU } from './menus';
import { diagramContext, openRelatedDiagram, openSchemaDiagram, openSelectedDiagram, openSyntheticDiagram } from './open';
import type { ErController } from './store';
import { ErDiagramTab } from './views';

const TABULAR = new Set(['table', 'view', 'mview']);

const active = () => {
  const c = activeController();
  return !!c && !!c.state.model;
};
const ready = () => activeController()?.state.phase === 'ready';

/** Data / design / DDL of a card go through the shell's commands with an explorer-style object target. */
function objectArgs(c: ErController, key: string) {
  const n = c.state.model?.byKey.get(key);
  if (!n) return null;
  const s = c.state;
  return { kind: 'object' as const, connectionId: s.connectionId, database: s.database, ref: { database: s.database, schema: n.schema || null, name: n.name, type: n.type } };
}

function fkReasonOf(c: ErController): string | null {
  return fkUnavailableReason(c.state.connectionId, !!c.state.synthetic);
}

function baseName(c: ErController): string {
  const s = c.state;
  const raw = s.scope.schema ?? (s.scope.tables?.[0] ?? 'diagram').split('.').pop() ?? 'diagram';
  return `ER ${raw}`.replace(/[\\/:*?"<>|]+/g, '_');
}

export async function exportDiagram(c: ErController, format: 'png' | 'svg'): Promise<void> {
  const s = c.state;
  if (!s.model || !s.model.nodes.length) {
    toast('info', 'The diagram is empty');
    return;
  }
  const input = { model: s.model, geom: s.geom, positions: s.positions, edges: s.edges, showTypes: s.options.types };
  try {
    const name = `${baseName(c)}.${format}`;
    if (format === 'svg') {
      const { buildSvg } = await import('./exportSvg');
      const saved = await getPlatform().saveFile({ suggestedName: name, filters: [{ name: 'SVG image', extensions: ['svg'] }], content: buildSvg(input), mime: 'image/svg+xml' });
      if (saved) toast('success', `Exported ${saved}`);
    } else {
      const { renderPng } = await import('./exportPng');
      const blob = await renderPng(input);
      const saved = await getPlatform().saveFile({ suggestedName: name, filters: [{ name: 'PNG image', extensions: ['png'] }], content: blob, mime: 'image/png' });
      if (saved) toast('success', `Exported ${saved}`);
    }
  } catch (e) {
    toast('error', `Could not export the diagram as ${format.toUpperCase()}`, errorMessage(e));
  }
}

const card = (id: string, title: string, icon: string, run: (c: ErController, key: string) => unknown, extra: Partial<Command<never>> = {}): Command<never> => ({
  id, title, category: 'ER diagram', icon,
  when: (args?: unknown) => {
    const t = cardTarget(args);
    return !!t && !t.c.state.model!.byKey.get(t.key)!.ghost;
  },
  run: (args?: unknown) => {
    const t = cardTarget(args);
    if (t) return run(t.c, t.key);
  },
  ...extra,
});

const view = (id: string, title: string, icon: string, run: (c: ErController) => unknown, extra: Partial<Command<never>> = {}): Command<never> => ({
  id, title, category: 'ER diagram', icon,
  when: () => active(),
  run: () => {
    const c = activeController();
    if (c) return run(c);
  },
  ...extra,
});

const move = (id: string, title: string, key: string, dx: number, dy: number): Command<never> => ({
  id, title, category: 'ER diagram', icon: 'ArrowRightLeft', shortcut: key, scope: 'er-canvas', palette: false,
  when: () => {
    const c = activeController();
    return !!c && (c.state.selection.length > 0 || !!c.state.focusKey);
  },
  run: () => activeController()?.moveSelection(dx, dy),
});

export const ER_COMMANDS: Command<never>[] = [
  {
    id: 'er.open', title: 'ER diagram', category: 'View', shortcut: 'Mod+Alt+E', icon: 'Waypoints',
    keywords: 'entity relationship erd schema diagram foreign keys tables model visualize',
    when: (args?: unknown) => !!diagramContext(args),
    run: (args?: unknown) => void openSchemaDiagram(args),
  },
  {
    id: 'er.openRelated', title: 'Diagram of related tables', category: 'Database', icon: 'Network', keywords: 'er erd foreign keys neighbours references',
    when: (args?: unknown) => {
      const t = objectTargetOf(args);
      return !!t && TABULAR.has(t.ref.type);
    },
    run: (args?: unknown) => {
      const t = objectTargetOf(args);
      if (t) void openRelatedDiagram(t);
    },
  },
  {
    id: 'er.openSelected', title: 'Diagram of selected tables', category: 'Database', icon: 'Workflow', keywords: 'er erd multi selection',
    when: (args?: unknown) => {
      const t = objectTargetOf(args);
      return !!t && (t.refs ?? []).filter((r) => TABULAR.has(r.type)).length >= 2;
    },
    run: (args?: unknown) => {
      const t = objectTargetOf(args);
      if (t) openSelectedDiagram(t);
    },
  },

  // ---- whole view
  view('er.search', 'Find table in diagram', 'Search', (c) => c.requestSearchFocus(), { shortcut: 'Mod+F', scope: 'er', keywords: 'search locate zoom to table column' }),
  view('er.addTables', 'Add tables to diagram…', 'Plus', (c) => c.setAddOpen(true), { when: () => active() && !activeController()!.state.synthetic }),
  view('er.toggleDetails', 'Toggle diagram details pane', 'PanelsTopLeft', (c) => c.setOption('details', !c.state.options.details)),
  view('er.fit', 'Fit diagram to window', 'Maximize2', (c) => c.fit(), { shortcut: 'F', scope: 'er-canvas', keywords: 'zoom to fit all' }),
  view('er.zoomIn', 'Zoom diagram in', 'ZoomIn', (c) => c.zoomStep(1), { shortcut: '=', altShortcuts: ['Shift+='], scope: 'er-canvas' }),
  view('er.zoomOut', 'Zoom diagram out', 'ZoomOut', (c) => c.zoomStep(-1), { shortcut: '-', scope: 'er-canvas' }),
  view('er.zoomReset', 'Zoom diagram to 100 %', 'ZoomIn', (c) => c.zoomTo(1), { shortcut: '0', scope: 'er-canvas', keywords: 'actual size reset zoom' }),
  view('er.selectAll', 'Select all tables in diagram', 'ListChecks', (c) => c.selectAll(), { shortcut: 'Mod+A', scope: 'er-canvas' }),
  {
    id: 'er.clearSelection', title: 'Clear diagram selection', category: 'ER diagram', icon: 'X', shortcut: 'Escape', scope: 'er-canvas', palette: false,
    when: () => (activeController()?.state.selection.length ?? 0) > 0,
    run: () => activeController()?.select([]),
  },
  view('er.layoutLR', 'Auto layout: layered, left to right', 'Workflow', (c) => void c.relayout('layered-lr', { save: true }), { when: ready }),
  view('er.layoutTB', 'Auto layout: layered, top to bottom', 'Workflow', (c) => void c.relayout('layered-tb', { save: true }), { when: ready }),
  view('er.layoutGrid', 'Auto layout: grid', 'LayoutList', (c) => void c.relayout('grid', { save: true }), { when: ready }),
  view('er.resetLayout', 'Reset diagram layout', 'RotateCcw', (c) => void c.resetLayout(), { when: ready, keywords: 'forget positions pins auto layout' }),
  view('er.exportPng', 'Export diagram as PNG…', 'Download', (c) => void exportDiagram(c, 'png'), { when: ready, keywords: 'image picture save' }),
  view('er.exportSvg', 'Export diagram as SVG…', 'Download', (c) => void exportDiagram(c, 'svg'), { when: ready, keywords: 'vector image save' }),

  // ---- cards (args: ErCardArgs from the card menu / details pane; else the focused card of the active diagram)
  card('er.openData', 'Open data', 'Table2', (c, key) => runCommand('data.open', objectArgs(c, key)), { shortcut: 'Enter', scope: 'er-canvas' }),
  card('er.design', 'Design table', 'PencilRuler', (c, key) => runCommand('designer.edit', objectArgs(c, key)), {
    shortcut: 'F4', scope: 'er-canvas',
    when: (args?: unknown) => {
      const t = cardTarget(args);
      return !!t && !t.c.state.synthetic && !t.c.state.model!.byKey.get(t.key)!.ghost;
    },
  }),
  card('er.openDdl', 'Open DDL', 'FileCode2', (c, key) => runCommand('explorer.openDdl', objectArgs(c, key)), {
    when: (args?: unknown) => {
      const t = cardTarget(args);
      return !!t && !t.c.state.synthetic && !t.c.state.model!.byKey.get(t.key)!.unresolved;
    },
  }),
  card('er.copyName', 'Copy table name', 'Copy', (c, key) => {
    const n = c.state.model!.byKey.get(key)!;
    return copyText(dialectOf(c.state.connectionId) === 'sqlite' && n.schema === 'main' ? n.name : `${n.schema}.${n.name}`, 'Copied table name');
  }, { when: (args?: unknown) => !!cardTarget(args) }),
  card('er.showRelated', 'Show related tables', 'Network', (c, key) => c.showRelated(key), { when: (args?: unknown) => !!cardTarget(args) }),
  {
    id: 'er.addGhost', title: 'Add to diagram', category: 'ER diagram', icon: 'Plus',
    when: (args?: unknown) => {
      const t = cardTarget(args);
      return !!t && !!t.c.state.model!.byKey.get(t.key)!.ghost;
    },
    run: (args?: unknown) => {
      const t = cardTarget(args);
      if (t) t.c.add([t.key]);
    },
  },
  card('er.pin', 'Pin / unpin card position', 'Pin', (c, key) => c.togglePin(key), { keywords: 'keep position auto layout lock' }),
  card('er.createFk', 'Create foreign key…', 'Link', (c, key) => c.setFkDraft({ from: key, fromColumn: null, to: null, toColumn: null }), {
    when: (args?: unknown) => {
      const t = cardTarget(args);
      return !!t && !t.c.state.model!.byKey.get(t.key)!.ghost && !fkReasonOf(t.c);
    },
    keywords: 'relationship reference constraint add',
  }),
  {
    id: 'er.remove', title: 'Remove from diagram', category: 'ER diagram', icon: 'X', shortcut: 'Delete', scope: 'er-canvas',
    keywords: 'hide table (does not drop)',
    when: (args?: unknown) => {
      if (cardTarget(args) && args) return true;
      const c = activeController();
      return !!c && (c.state.selection.length > 0 || !!c.state.focusKey);
    },
    run: (args?: unknown) => {
      const t = args ? cardTarget(args) : null;
      const c = t?.c ?? activeController();
      if (!c) return;
      const s = c.state;
      const keys = t && !s.selection.includes(t.key) ? [t.key] : s.selection.length ? s.selection : s.focusKey ? [s.focusKey] : [];
      const order = c.order();
      const next = order.find((k, i) => i > order.indexOf(keys[keys.length - 1]) && !keys.includes(k)) ?? order.filter((k) => !keys.includes(k)).pop() ?? null;
      c.remove(keys);
      if (next) c.focusCard(next, { reveal: false });
    },
  },

  // ---- keyboard navigation inside the canvas
  {
    id: 'er.nextCard', title: 'Next table in diagram', category: 'ER diagram', icon: 'ArrowRightLeft', shortcut: 'Tab', scope: 'er-canvas', palette: false,
    when: () => !!activeController()?.nextKey(1),
    run: () => {
      const c = activeController();
      const k = c?.nextKey(1);
      if (c && k) c.focusCard(k);
    },
  },
  {
    id: 'er.prevCard', title: 'Previous table in diagram', category: 'ER diagram', icon: 'ArrowRightLeft', shortcut: 'Shift+Tab', scope: 'er-canvas', palette: false,
    when: () => !!activeController()?.nextKey(-1),
    run: () => {
      const c = activeController();
      const k = c?.nextKey(-1);
      if (c && k) c.focusCard(k);
    },
  },
  move('er.moveLeft', 'Move selected tables left', 'ArrowLeft', -8, 0),
  move('er.moveRight', 'Move selected tables right', 'ArrowRight', 8, 0),
  move('er.moveUp', 'Move selected tables up', 'ArrowUp', 0, -8),
  move('er.moveDown', 'Move selected tables down', 'ArrowDown', 0, 8),
  {
    id: 'er.cardMenu', title: 'Table actions menu', category: 'ER diagram', icon: 'LayoutList', shortcut: 'Shift+F10', scope: 'er-canvas', palette: false,
    when: () => !!cardTarget(undefined),
    run: () => {
      const t = cardTarget(undefined);
      if (!t) return;
      const el = document.querySelector<HTMLElement>(`[data-tab-host="${cssEscape(t.c.tabId)}"] [data-key="${cssEscape(t.key)}"]`);
      const r = el?.getBoundingClientRect();
      showContextMenu({ clientX: (r?.left ?? 100) + 16, clientY: (r?.top ?? 100) + 24 }, commandMenuItems(ER_CARD_MENU, { kind: 'er-card', tabId: t.c.tabId, key: t.key }));
    },
  },
];

/** Dev/QA only: the 500-table synthetic diagram (QA "500-table synthetic file loads with LOD"). */
const DEV_COMMANDS: Command<never>[] = [
  {
    id: 'er.devSynthetic', title: 'Open synthetic 500-table ER diagram (dev)', category: 'ER diagram', icon: 'Waypoints', keywords: 'performance lod test',
    run: () => openSyntheticDiagram(),
  },
];

function focusPrimary(_tab: unknown, container: HTMLElement): boolean {
  const el = container.querySelector<HTMLElement>('.er-card.focus') ?? container.querySelector<HTMLElement>('.er-canvas');
  if (!el) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

let registered = false;

export function registerErCommands(): void {
  if (registered) return;
  registered = true;
  registerTabView(ER_VIEW_ID, { component: ErDiagramTab, icon: 'Waypoints', focusPrimary });
  registerCommands(ER_COMMANDS);
  if (import.meta.env.DEV) registerCommands(DEV_COMMANDS);
}
