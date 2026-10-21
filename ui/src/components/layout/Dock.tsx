import { Activity, Database, History } from 'lucide-react';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { displayShortcut } from '../../commands/keys';
import { useCatalog } from '../../store/catalog';
import { activityCounts, useSessions } from '../../store/sessions';
import { DOCK_MAX, DOCK_MIN, useUi, type DockPanel } from '../../store/ui';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Splitter } from '../common/Splitter';
import { pluralize } from '../common/text';
import { ConnectionsPanel } from '../ConnectionsPanel/ConnectionsPanel';
import { Explorer } from '../Explorer/Explorer';
import { HistoryPanel } from '../HistoryPanel/HistoryPanel';

const TABS: { id: DockPanel; label: string; Icon: typeof Database; shortcut?: string }[] = [
  { id: 'explorer', label: 'Explorer', Icon: Database, shortcut: 'Mod+Shift+E' },
  { id: 'history', label: 'History', Icon: History, shortcut: 'Mod+Shift+H' },
  { id: 'connections', label: 'Connections', Icon: Activity },
];

/** Width when the user never resized the dock: follows the window. */
const AUTO_WIDTH = `clamp(${DOCK_MIN}px, 22vw, ${DOCK_MAX}px)`;

/** Left dock: Explorer | History | Connections, tabbed, clamp(200px, 22vw, 480px), collapsible (Ctrl+B). */
export function Dock() {
  const visible = useUi((s) => s.explorerVisible);
  const width = useUi((s) => s.explorerWidth);
  const dock = useUi((s) => s.dock);
  const setLayout = useUi((s) => s.setLayout);
  const sessions = useSessions((s) => s.sessions);
  const catalogConns = useCatalog((s) => s.conns);
  // Engine-wide (GET /sessions is refreshed on session.changed), the same numbers as the status bar.
  const nSessions = useMemo(() => activityCounts(sessions, catalogConns).sessions, [sessions, catalogConns]);
  const asideRef = useRef<HTMLElement>(null);
  const [start, setStart] = useState(width);
  if (!visible) return null;

  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === dock);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    if (n < 0) return;
    e.preventDefault();
    useUi.getState().showDock(TABS[n].id);
    setTimeout(() => document.getElementById(`dock-tab-${TABS[n].id}`)?.focus(), 0);
  };

  return (
    <>
      <aside
        ref={asideRef}
        className="dock"
        style={{ width: width > 0 ? Math.max(DOCK_MIN, Math.min(DOCK_MAX, width)) : AUTO_WIDTH }}
        aria-label="Side panel"
        data-region="dock"
        tabIndex={-1}
      >
        <div className="dock-tabs" role="tablist" aria-label="Side panel" onKeyDown={onKeyDown}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`dock-tab-${t.id}`}
              role="tab"
              aria-selected={dock === t.id}
              aria-controls={`dock-panel-${t.id}`}
              tabIndex={dock === t.id ? 0 : -1}
              className={`dock-tab${dock === t.id ? ' active' : ''}`}
              title={t.shortcut ? `${t.label} (${displayShortcut(t.shortcut)})` : t.label}
              onClick={() => useUi.getState().showDock(t.id)}
            >
              <t.Icon size={14} strokeWidth={1.75} />
              <span>{t.label}</span>
              {t.id === 'connections' && nSessions > 0 && (
                <span className="dock-badge" aria-label={pluralize(nSessions, 'open session')} title={pluralize(nSessions, 'open session')}>
                  {nSessions}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="dock-body" id={`dock-panel-${dock}`} role="tabpanel" aria-labelledby={`dock-tab-${dock}`}>
          {/* One boundary per panel (keyed): a crashed panel leaves the dock tabs and the other panels usable. */}
          <ErrorBoundary key={dock} area={`the ${TABS.find((t) => t.id === dock)?.label ?? 'side'} panel`} variant="panel">
            {dock === 'explorer' && <Explorer />}
            {dock === 'history' && <HistoryPanel />}
            {dock === 'connections' && <ConnectionsPanel />}
          </ErrorBoundary>
        </div>
      </aside>
      <Splitter
        direction="vertical"
        ariaLabel="Resize side panel"
        onDragStart={() => setStart(asideRef.current?.offsetWidth ?? (width || DOCK_MIN))}
        onDrag={(d) => setLayout({ explorerWidth: Math.max(DOCK_MIN, Math.min(DOCK_MAX, start + d)) })}
        // Double-click: back to the automatic width (22% of the window).
        onDoubleClick={() => setLayout({ explorerWidth: 0 })}
      />
    </>
  );
}
