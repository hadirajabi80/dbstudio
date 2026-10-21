// M2-L commands (auto-loaded by commands/index.ts) and the 'logs' tab view (docs/PLAN-M2.md 8.2).
//   view.logs (Mod+Alt+Shift+L)   explorer connection / source node, { connectionId, sub?, sourceId? }, or the active
//                                 tab's connection (else the engine log)
//   logs.*                        act on the active logs tab (components/Logs/controller.ts)
// In-view keys are scoped: `logs` is the view root, `logsList` the focused entry list (Space / Enter / Mod+C there
// never reach a text field). F5 (refresh) and Mod+L (clear) are handled by the view itself: both keys are taken by
// app-wide bindings (run.script, explain.estimated), see LogsView.tsx.
import { ENGINE_LOG_CID } from '../../api/client.m2';
import { registerCommands, type Command } from '../../commands/registry';
import { getActiveTab } from '../../store/tabs';
import { registerTabView } from '../layout/tabViews';
import { activeLogsController, type LogsController } from './controller';
import { LEVEL_CHIPS, LOGS_VIEW, normalizeLogsState, openLogs, type LogsSub } from './open';
import { LogsTab } from './views';

/** Args of view.logs besides explorer targets. */
export interface LogsOpenArgs {
  connectionId: string;
  sub?: LogsSub;
  sourceId?: string;
}

function argsOf(a: unknown): LogsOpenArgs | null {
  if (!a || typeof a !== 'object') return null;
  const o = a as Partial<LogsOpenArgs> & { kind?: string };
  if (typeof o.connectionId !== 'string' || !o.connectionId) return null;
  if (o.kind && o.kind !== 'connection' && o.kind !== 'source' && o.kind !== 'object' && o.kind !== 'container') return null;
  return { connectionId: o.connectionId, sub: o.sub === 'activity' || o.sub === 'logs' ? o.sub : undefined, sourceId: typeof o.sourceId === 'string' ? o.sourceId : undefined };
}

/** Connection of the active tab: a console/object/view tab's connection; a logs tab's own connection (engine too). */
export function activeLogsConnection(): string {
  const t = getActiveTab();
  if (!t) return ENGINE_LOG_CID;
  if (t.kind === 'view' && t.view === LOGS_VIEW) return normalizeLogsState(t.state, t.connectionId).connectionId;
  return t.connectionId ?? ENGINE_LOG_CID;
}

const ctl = (a?: unknown): LogsController | undefined => activeLogsController(a);
const logsSub = (a?: unknown) => ctl(a)?.sub() === 'logs';
const activitySub = (a?: unknown) => ctl(a)?.sub() === 'activity';

/** Focus is on a control inside the entry list (an expanded row's Copy button): Space / Enter belong to it. */
function focusInListControl(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return !!el && el.matches('button, input, textarea, select, a[href]') && !!el.closest('[data-command-scope~="logsList"]');
}

function hasTextSelection(): boolean {
  try {
    return !!window.getSelection()?.toString();
  } catch {
    return false;
  }
}

const LEVEL_TITLES: Record<string, string> = { debug: 'debug', info: 'info', warn: 'warning', error: 'error' };

export const LOGS_COMMANDS: Command<never>[] = [
  {
    id: 'view.logs', title: 'Logs & activity', category: 'View', shortcut: 'Mod+Alt+Shift+L', icon: 'ScrollText',
    keywords: 'server log error log alert activity sessions locks kill monitor slowlog engine log',
    run: (a?: unknown) => {
      const o = argsOf(a);
      if (o) openLogs(o.connectionId, { sub: o.sub, sourceId: o.sourceId });
      else openLogs(activeLogsConnection());
    },
  },
  {
    id: 'logs.openEngineLog', title: 'Open engine log', category: 'Logs', icon: 'FileText', keywords: 'dbstudio engine serilog diagnostics',
    run: () => openLogs(ENGINE_LOG_CID, { sub: 'logs', sourceId: 'engine' }),
  },
  { id: 'logs.showLogs', title: 'Show logs', category: 'Logs', icon: 'ScrollText', when: (a?: unknown) => !!ctl(a), run: (a?: unknown) => ctl(a)?.setSub('logs') },
  { id: 'logs.showActivity', title: 'Show activity', category: 'Logs', icon: 'Activity', keywords: 'sessions processes locks', when: (a?: unknown) => !!ctl(a), run: (a?: unknown) => ctl(a)?.setSub('activity') },
  ...LEVEL_CHIPS.map((l): Command<never> => ({
    id: `logs.level.${l}`, title: `Toggle ${LEVEL_TITLES[l]} entries`, category: 'Logs', icon: 'ListFilter', keywords: `level filter ${l}${l === 'error' ? ' fatal' : ''}`,
    when: (a?: unknown) => logsSub(a), run: (a?: unknown) => ctl(a)?.toggleLevel(l),
  })),
  {
    id: 'logs.tail', title: 'Toggle live tail', category: 'Logs', icon: 'Radio', keywords: 'follow stream live',
    when: (a?: unknown) => logsSub(a) && !!ctl(a)?.canTail(), run: (a?: unknown) => ctl(a)?.toggleTail(),
  },
  {
    id: 'logs.pause', title: 'Pause / resume tail', category: 'Logs', shortcut: 'Space', scope: 'logsList', icon: 'CircleStop',
    when: (a?: unknown) => logsSub(a) && !!ctl(a)?.canPause() && !focusInListControl(), run: (a?: unknown) => ctl(a)?.togglePause(),
  },
  { id: 'logs.clear', title: 'Clear log view', category: 'Logs', icon: 'Eraser', when: (a?: unknown) => logsSub(a), run: (a?: unknown) => ctl(a)?.clear() },
  {
    id: 'logs.search', title: 'Search logs', category: 'Logs', shortcut: 'Mod+F', scope: 'logs', icon: 'Search', keywords: 'find filter regex',
    when: (a?: unknown) => !!ctl(a), run: (a?: unknown) => ctl(a)?.focusSearch(),
  },
  {
    id: 'logs.copyEntry', title: 'Copy log entry', category: 'Logs', shortcut: 'Mod+C', scope: 'logsList', icon: 'Copy',
    when: (a?: unknown) => logsSub(a) && !!ctl(a)?.hasSelection() && !hasTextSelection(), run: (a?: unknown) => ctl(a)?.copySelected(),
  },
  {
    id: 'logs.expandEntry', title: 'Expand / collapse log entry', category: 'Logs', shortcut: 'Enter', scope: 'logsList', icon: 'ChevronsDownUp',
    when: (a?: unknown) => logsSub(a) && !!ctl(a)?.hasSelection() && !focusInListControl(), run: (a?: unknown) => ctl(a)?.expandSelected(),
  },
  {
    id: 'logs.loadOlder', title: 'Load older log entries', category: 'Logs', icon: 'History',
    when: (a?: unknown) => logsSub(a) && !!ctl(a)?.canLoadOlder(), run: (a?: unknown) => ctl(a)?.loadOlder(),
  },
  { id: 'logs.refresh', title: 'Refresh logs and activity', category: 'Logs', icon: 'RefreshCw', when: (a?: unknown) => !!ctl(a), run: (a?: unknown) => ctl(a)?.refresh() },
  { id: 'logs.wrap', title: 'Toggle line wrap', category: 'Logs', icon: 'Rows2', when: (a?: unknown) => logsSub(a), run: (a?: unknown) => ctl(a)?.toggleWrap() },
  ...(['txt', 'csv', 'json'] as const).map((f): Command<never> => ({
    id: `logs.export.${f}`, title: `Export log as ${f === 'txt' ? 'text' : f.toUpperCase()}…`, category: 'Logs', icon: 'Download', keywords: 'save file download',
    when: (a?: unknown) => logsSub(a) && !!ctl(a)?.canExport(), run: (a?: unknown) => ctl(a)?.exportAs(f),
  })),
  {
    id: 'logs.activity.kill', title: 'Kill session…', category: 'Logs', icon: 'Skull', danger: true, keywords: 'terminate process spid pid client op',
    when: (a?: unknown) => activitySub(a) && !!ctl(a)?.canKill(), run: (a?: unknown) => ctl(a)?.kill(),
  },
  {
    id: 'logs.activity.cancel', title: 'Cancel running query', category: 'Logs', icon: 'Ban', keywords: 'pg_cancel_backend postgresql',
    when: (a?: unknown) => activitySub(a) && !!ctl(a)?.canCancel(), run: (a?: unknown) => ctl(a)?.cancelQuery(),
  },
  {
    id: 'logs.activity.openStatement', title: 'Open statement in console', category: 'Logs', icon: 'SquareTerminal',
    when: (a?: unknown) => activitySub(a) && !!ctl(a)?.canOpenStatement(), run: (a?: unknown) => ctl(a)?.openStatement(),
  },
  {
    id: 'logs.activity.onlyActive', title: 'Toggle only active sessions', category: 'Logs', icon: 'Filter', keywords: 'idle sleeping hide',
    when: (a?: unknown) => activitySub(a), run: (a?: unknown) => ctl(a)?.toggleOnlyActive(),
  },
  {
    id: 'logs.copyGrant', title: 'Copy GRANT statement', category: 'Logs', icon: 'ShieldAlert', keywords: 'privilege permission dba',
    when: (a?: unknown) => !!ctl(a)?.grant(), run: (a?: unknown) => ctl(a)?.copyGrant(),
  },
];

/** Primary focus of a logs tab: the entry list (or the activity grid). */
export function focusLogsPrimary(_tab: unknown, container: HTMLElement): boolean {
  const el = container.querySelector<HTMLElement>('.logs-view [data-primary-focus]');
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
}

let registered = false;

export function registerLogsCommands(): void {
  if (registered) return;
  registered = true;
  registerTabView(LOGS_VIEW, { component: LogsTab, icon: 'ScrollText', focusPrimary: focusLogsPrimary });
  registerCommands(LOGS_COMMANDS);
}

export { LOGS_VIEW };
