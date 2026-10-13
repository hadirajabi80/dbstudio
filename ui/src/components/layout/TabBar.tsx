import { Plus, SquareTerminal, X } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { closeTab, newConsole } from '../../app/actions';
import { useConnections } from '../../store/connections';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { isDirty, useTabs, type Tab } from '../../store/tabs';
import { showContextMenu } from '../common/Menu';
import { ObjectIcon } from '../common/icons';

/** Editor tabs. Each tab shows its connection colour (top bar) and name, dirty dot, running/tx state. */
export function TabBar() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const [dragId, setDragId] = useState<string | null>(null);
  return (
    <div className="tabbar" role="tablist" aria-label="Editor tabs">
      <div className="tabbar-scroll">
        {tabs.map((t) => (
          <TabItem key={t.id} tab={t} active={t.id === activeId} dragId={dragId} setDragId={setDragId} />
        ))}
      </div>
      <button className="icon-btn tabbar-add" title="New console (Ctrl+T)" aria-label="New console" onClick={() => newConsole()}>
        <Plus size={15} />
      </button>
    </div>
  );
}

function TabItem({ tab, active, dragId, setDragId }: { tab: Tab; active: boolean; dragId: string | null; setDragId: (id: string | null) => void }) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId));
  const running = useResults((s) => isRunning(s.executions[s.byTab[tab.id]]));
  const txOpen = useSessions((s) => {
    const sid = s.byTab[tab.id];
    return sid ? s.sessions[sid]?.txOpen : false;
  });
  const dirty = isDirty(tab);
  const t = useTabs.getState();
  const [renaming, setRenaming] = useState(false);

  return (
    <div
      role="tab"
      aria-selected={active}
      className={`tab${active ? ' active' : ''}${dragId === tab.id ? ' dragging' : ''}`}
      style={conn?.color ? ({ '--tab-color': conn.color } as CSSProperties) : undefined}
      title={`${tab.title}${conn ? ` — ${conn.name}` : ''}${tab.kind === 'console' && tab.filePath ? `\n${tab.filePath}` : ''}`}
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
      onDoubleClick={() => tab.kind === 'console' && setRenaming(true)}
      onContextMenu={(e) =>
        showContextMenu(e, [
          { label: 'Close', shortcut: 'Ctrl+W', onClick: () => void closeTab(tab.id) },
          { label: 'Close others', onClick: () => useTabs.getState().tabs.filter((x) => x.id !== tab.id).forEach((x) => void closeTab(x.id)) },
          { separator: true },
          { label: 'Rename', disabled: tab.kind !== 'console', onClick: () => setRenaming(true) },
          {
            label: 'Duplicate console',
            disabled: tab.kind !== 'console',
            onClick: () => tab.kind === 'console' && newConsole(tab.connectionId, tab.database, tab.text),
          },
        ])
      }
    >
      <span className="tab-icon">{tab.kind === 'object' ? <ObjectIcon type={tab.ref.type} size={13} /> : <SquareTerminal size={13} />}</span>
      {renaming ? (
        <input
          className="tab-rename"
          autoFocus
          defaultValue={tab.title}
          onMouseDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            if (e.target.value.trim()) t.rename(tab.id, e.target.value.trim());
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <span className="tab-title">{tab.title}</span>
      )}
      {conn && <span className="tab-conn">{conn.name}</span>}
      {running && <span className="tab-running" title="Running" />}
      {txOpen && <span className="tab-tx" title="Uncommitted transaction">tx</span>}
      <button
        className={`tab-close${dirty ? ' dirty' : ''}`}
        aria-label={`Close ${tab.title}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void closeTab(tab.id);
        }}
      >
        <span className="tab-dirty-dot" />
        <X size={13} />
      </button>
    </div>
  );
}
