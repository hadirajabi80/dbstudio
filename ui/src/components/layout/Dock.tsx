import { Activity, Database, History } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { displayShortcut } from '../../commands/keys';
import { useSessions } from '../../store/sessions';
import { DOCK_MAX, DOCK_MIN, useUi, type DockPanel } from '../../store/ui';
import { Splitter } from '../common/Splitter';
import { ConnectionsPanel } from '../ConnectionsPanel/ConnectionsPanel';
import { Explorer } from '../Explorer/Explorer';
import { HistoryPanel } from '../HistoryPanel/HistoryPanel';

const TABS: { id: DockPanel; label: string; Icon: typeof Database; shortcut?: string }[] = [
  { id: 'explorer', label: 'Explorer', Icon: Database, shortcut: 'Mod+Shift+E' },
  { id: 'history', label: 'History', Icon: History, shortcut: 'Mod+Shift+H' },
  { id: 'connections', label: 'Connections', Icon: Activity },
];

/** Left dock: Explorer | History | Connections, tabbed, 220–480 px, collapsible (Ctrl+B). */
export function Dock() {
  const visible = useUi((s) => s.explorerVisible);
  const width = useUi((s) => s.explorerWidth);
  const dock = useUi((s) => s.dock);
  const setLayout = useUi((s) => s.setLayout);
  const nSessions = useSessions((s) => Object.keys(s.sessions).length);
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
      <aside className="dock" style={{ width }} aria-label="Side panel">
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
              {t.id === 'connections' && nSessions > 0 && <span className="dock-badge">{nSessions}</span>}
            </button>
          ))}
        </div>
        <div className="dock-body" id={`dock-panel-${dock}`} role="tabpanel" aria-labelledby={`dock-tab-${dock}`}>
          {dock === 'explorer' && <Explorer />}
          {dock === 'history' && <HistoryPanel />}
          {dock === 'connections' && <ConnectionsPanel />}
        </div>
      </aside>
      <Splitter
        direction="vertical"
        ariaLabel="Resize side panel"
        onDragStart={() => setStart(width)}
        onDrag={(d) => setLayout({ explorerWidth: Math.max(DOCK_MIN, Math.min(DOCK_MAX, start + d)) })}
        onDoubleClick={() => setLayout({ explorerWidth: 280 })}
      />
    </>
  );
}
