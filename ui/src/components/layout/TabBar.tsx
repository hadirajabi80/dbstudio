import { Lock, Plus, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { closeTab } from '../../app/actions';
import { runCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { isDirty, useTabs, type Tab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { connColorCss, connColorName } from '../../theme/connColors';
import { showContextMenu } from '../common/Menu';
import { ObjectIcon } from '../common/icons';
import { commandIcon, contextMenu } from './commandMenu';
import { getTabView } from './tabViews';

/** Editor tabs: connection colour bar + name, dirty dot, running/tx state; draggable, middle-click closes. */
export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const [dragId, setDragId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>('.tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const onKeyDown = (e: KeyboardEvent) => {
    const idx = tabs.findIndex((t) => t.id === activeId);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else if (e.key === 'Delete' && activeId) {
      e.preventDefault();
      void closeTab(activeId);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    useTabs.getState().activate(tabs[next].id);
    setTimeout(() => scrollRef.current?.querySelector<HTMLElement>('.tab.active')?.focus(), 0);
  };

  // With every tab on one connection the suffix says nothing the colour bar does not (features-r1-05).
  const showConn = new Set(tabs.map((t) => t.connectionId).filter(Boolean)).size > 1;
  const add = commandView('file.newConsole');
  return (
    <div className="tabbar" role="tablist" aria-label="Editor tabs" onKeyDown={onKeyDown}>
      <div className="tabbar-scroll" ref={scrollRef}>
        {tabs.map((t) => (
          <TabItem key={t.id} tab={t} active={t.id === activeId} showConn={showConn} dragId={dragId} setDragId={setDragId} />
        ))}
      </div>
      <button className="icon-btn tabbar-add" title={add.tooltip} aria-label="New console" onClick={add.run}>
        <Plus size={16} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === 'object') return <ObjectIcon type={tab.ref.type} size={14} />;
  if (tab.kind === 'view') return commandIcon(getTabView(tab.view)?.icon ?? 'File', 14) ?? <SquareTerminal size={14} strokeWidth={1.5} />;
  return <SquareTerminal size={14} strokeWidth={1.5} />;
}

function TabItem({ tab, active, showConn, dragId, setDragId }: {
  tab: Tab; active: boolean; showConn: boolean; dragId: string | null; setDragId: (id: string | null) => void;
}) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId));
  const running = useResults((s) => isRunning(s.executions[s.byTab[tab.id]]));
  const txOpen = useSessions((s) => {
    const sid = s.byTab[tab.id];
    return sid ? !!s.sessions[sid]?.txOpen : false;
  });
  const renaming = useUi((s) => s.renamingTabId === tab.id);
  const dirty = isDirty(tab);
  const t = useTabs.getState();
  const color = connColorCss(conn?.color);
  const tooltip = [
    tab.title,
    conn ? `${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''}${conn.readOnly ? ' · read-only' : ''}` : null,
    tab.kind === 'console' && tab.filePath ? tab.filePath : null,
    txOpen ? 'Uncommitted transaction' : null,
  ].filter(Boolean).join('\n');

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`tab${active ? ' active' : ''}${dragId === tab.id ? ' dragging' : ''}${color ? ' has-color' : ''}`}
      style={color ? ({ '--tab-color': color } as CSSProperties) : undefined}
      title={tooltip}
      draggable={!renaming}
      onDragStart={(e) => {
        setDragId(tab.id);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-dbstudio-tab', tab.id);
      }}
      onDragOver={(e) => {
        if (dragId && dragId !== tab.id) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragId) t.move(dragId, tab.id);
        setDragId(null);
      }}
      onDragEnd={() => setDragId(null)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.id);
        } else if (e.button === 0) t.activate(tab.id);
      }}
      onDoubleClick={() => tab.kind === 'console' && runCommand('tab.rename', { kind: 'tab', tabId: tab.id })}
      onContextMenu={(e) => showContextMenu(e, contextMenu('tab', { kind: 'tab', tabId: tab.id }))}
    >
      <span className="tab-icon">
        <TabIcon tab={tab} />
      </span>
      <span className="tab-label">
        {renaming ? (
          <input
            className="tab-rename"
            autoFocus
            aria-label="Tab name"
            defaultValue={tab.title}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              if (e.target.value.trim()) t.rename(tab.id, e.target.value.trim());
              useUi.getState().setRenamingTab(null);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') useUi.getState().setRenamingTab(null);
            }}
          />
        ) : (
          <span className="tab-title">{tab.title}</span>
        )}
        {/* Redundant with a single connection, or when the title already names it ("Sample: Shop", "Orders · Shop"). */}
        {conn && showConn && !tab.title.toLowerCase().includes(conn.name.toLowerCase()) && <span className="tab-conn">{conn.name}</span>}
      </span>
      {conn?.readOnly && <Lock size={11} className="tab-lock" aria-label="Read-only connection" />}
      {running && <span className="tab-running" role="img" aria-label="Running" />}
      {txOpen && <span className="tab-tx" title="Uncommitted transaction">tx</span>}
      <button
        className={`tab-close${dirty ? ' dirty' : ''}`}
        aria-label={`Close ${tab.title}`}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(tab.id);
        }}
      >
        <span className="tab-dirty-dot" />
        <X size={14} />
      </button>
    </div>
  );
}
