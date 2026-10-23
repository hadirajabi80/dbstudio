import { Columns2, Lock, Plus, SquareArrowOutDownLeft, SquareTerminal, X } from 'lucide-react';
import { useEffect, useRef, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { closeTab } from '../../app/actions';
import { detachTab } from '../../app/detach';
import { runCommand } from '../../commands/registry';
import { commandView } from '../../commands/useCommands';
import { useConnections } from '../../store/connections';
import { isDragOutsideWindow } from '../../store/editorGroups';
import { useResults } from '../../store/results';
import { isRunning } from '../../store/resultsReducer';
import { useSessions } from '../../store/sessions';
import { OBJECTS_TAB_SETTING, useSettings } from '../../store/settings';
import { groupTabs, isDirty, isPinnedTab, useTabs, type Tab } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { connColorCss, connColorName } from '../../theme/connColors';
import { showContextMenu } from '../common/Menu';
import { ObjectIcon } from '../common/icons';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { isTabDrag, TAB_MIME, useTabDrag } from '../EditorGroups/dnd';
import { commandIcon, contextMenu } from './commandMenu';
import { getTabView } from './tabViews';

/**
 * Editor tabs of one editor group: connection colour bar + name, dirty dot, running/tx state; middle-click closes.
 * Tabs drag to reorder, onto another group's strip to move there, onto a group's body to split (EditorGroups), and out
 * of the window to open in a window of their own (desktop).
 */
export function TabBar({ groupId }: { groupId?: string } = {}) {
  const allTabs = useTabs((s) => s.tabs);
  const group = useTabs((s) => s.groups.find((g) => g.id === groupId) ?? (groupId ? undefined : s.groups.find((g) => g.id === s.focusedGroup) ?? s.groups[0]));
  const gid = group?.id ?? '';
  const tabs = groupTabs(allTabs, group);
  const activeId = group?.activeId ?? null;
  const multiGroup = useTabs((s) => s.groups.length > 1);
  const dragOver = useTabDrag((s) => (s.over?.kind !== 'zone' && s.over?.groupId === gid ? s.over : null));
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

  // Dropping on the strip's empty part appends to this group.
  const onStripDragOver = (e: DragEvent) => {
    if (!isTabDrag()) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (e.target === e.currentTarget || (e.target as HTMLElement).closest?.('.tabbar-fill')) useTabDrag.getState().setOver({ kind: 'strip', groupId: gid });
  };
  const onStripDrop = (e: DragEvent) => {
    const { tabId, over } = useTabDrag.getState();
    if (!tabId) return;
    e.preventDefault();
    applyStripDrop(tabId, gid, over);
    useTabDrag.getState().end();
  };

  // With every tab on one connection the suffix says nothing the colour bar does not (features-r1-05).
  const showConn = new Set(allTabs.map((t) => t.connectionId).filter(Boolean)).size > 1;
  const add = commandView('file.newConsole');
  const split = commandView('view.splitRight', activeId ? { kind: 'tab', tabId: activeId } : undefined);
  const back = commandView('view.reattachTab', activeId ? { kind: 'tab', tabId: activeId } : undefined);
  return (
    <div
      className={`tabbar${dragOver?.kind === 'strip' ? ' drop-end' : ''}`}
      role="tablist"
      aria-label={multiGroup ? 'Editor tabs of this group' : 'Editor tabs'}
      onKeyDown={onKeyDown}
      onDragOver={onStripDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && useTabDrag.getState().over?.groupId === gid) useTabDrag.getState().setOver(null);
      }}
      onDrop={onStripDrop}
    >
      <div className="tabbar-scroll" ref={scrollRef}>
        {tabs.map((t) => (
          <TabItem
            key={t.id}
            tab={t}
            groupId={gid}
            active={t.id === activeId}
            showConn={showConn}
            dropSide={dragOver?.kind === 'tab' && dragOver.tabId === t.id ? dragOver.side : null}
          />
        ))}
      </div>
      <button
        className="icon-btn tabbar-add"
        title={add.tooltip}
        aria-label="New console"
        onClick={() => {
          if (gid) useTabs.getState().focusGroup(gid);
          add.run();
        }}
      >
        <Plus size={16} strokeWidth={1.5} />
      </button>
      <div className="tabbar-fill" />
      <div className="tabbar-actions">
        {back.enabled && (
          <button className="btn btn-xs tabbar-reattach" title={back.tooltip} onClick={back.run}>
            <SquareArrowOutDownLeft size={14} strokeWidth={1.5} /> Move back to main window
          </button>
        )}
        {split.enabled && activeId && (
          <button
            className="icon-btn sm tabbar-split"
            title={split.tooltip}
            aria-label="Split right"
            onClick={() => runCommand('view.splitRight', { kind: 'tab', tabId: activeId })}
          >
            <Columns2 size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </div>
  );
}

/** Drop on a strip: before/after the tab under the pointer, or at the end of the group. */
function applyStripDrop(tabId: string, groupId: string, over: ReturnType<typeof useTabDrag.getState>['over']): void {
  const s = useTabs.getState();
  const group = s.groups.find((g) => g.id === groupId);
  if (!group) return;
  if (over?.kind === 'tab' && over.groupId === groupId) {
    const ids = group.tabIds.filter((id) => id !== tabId);
    const at = ids.indexOf(over.tabId);
    const beforeId = over.side === 'before' ? over.tabId : ids[at + 1] ?? null;
    s.moveTab(tabId, groupId, beforeId);
    return;
  }
  s.moveTab(tabId, groupId, null);
}

/** Object tabs show the object type, view tabs their view's icon, a console its connection's product logo. */
function TabIcon({ tab, providerId }: { tab: Tab; providerId?: string }) {
  if (tab.kind === 'object') return <ObjectIcon type={tab.ref.type} size={14} />;
  if (tab.kind === 'view') return commandIcon(getTabView(tab.view)?.icon ?? 'File', 14) ?? <SquareTerminal size={14} strokeWidth={1.5} />;
  if (providerId) return <ProviderLogo providerId={providerId} size={14} />;
  return <SquareTerminal size={14} strokeWidth={1.5} />;
}

/**
 * The permanent Objects tab: first in the strip, no close button, not draggable (other tabs dropped on it land after
 * it). Its menu offers to hide it (Settings › General › Show the Objects tab).
 */
function PinnedTabItem({ tab, active }: { tab: Tab; active: boolean }) {
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      data-pinned=""
      className={`tab pinned${active ? ' active' : ''}`}
      title={`${tab.title}: the objects of what is selected in the explorer (always open)`}
      draggable={false}
      onMouseDown={(e) => {
        if (e.button === 0) useTabs.getState().activate(tab.id);
        else if (e.button === 1) e.preventDefault();
      }}
      onContextMenu={(e) => showContextMenu(e, [
        { label: 'Hide the Objects tab', onClick: () => useSettings.getState().update({ ui: { [OBJECTS_TAB_SETTING]: false } }) },
      ])}
    >
      <span className="tab-icon">
        <TabIcon tab={tab} />
      </span>
      <span className="tab-label">
        <span className="tab-title">{tab.title}</span>
      </span>
    </div>
  );
}

function TabItem({ tab, groupId, active, showConn, dropSide }: {
  tab: Tab; groupId: string; active: boolean; showConn: boolean; dropSide: 'before' | 'after' | null;
}) {
  const conn = useConnections((s) => s.connections.find((c) => c.id === tab.connectionId));
  const running = useResults((s) => isRunning(s.executions[s.byTab[tab.id]]));
  const txOpen = useSessions((s) => {
    const sid = s.byTab[tab.id];
    return sid ? !!s.sessions[sid]?.txOpen : false;
  });
  const renaming = useUi((s) => s.renamingTabId === tab.id);
  const dragging = useTabDrag((s) => s.tabId === tab.id);
  const dirty = isDirty(tab);
  const t = useTabs.getState();
  if (isPinnedTab(tab)) return <PinnedTabItem tab={tab} active={active} />;
  const color = connColorCss(conn?.color);
  const tooltip = [
    tab.title,
    conn ? `${conn.name}${conn.color ? ` (${connColorName(conn.color)})` : ''}${conn.readOnly ? ' · read-only' : ''}` : null,
    tab.kind === 'console' && tab.filePath ? tab.filePath : null,
    tab.kind === 'console' && tab.savedQuery
      ? `Saved query in ${[tab.savedQuery.database, tab.savedQuery.schema].filter((x, i, a) => x && a.indexOf(x) === i).join('.') || 'the connection'}`
      : null,
    txOpen ? 'Uncommitted transaction' : null,
  ].filter(Boolean).join('\n');

  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      className={`tab${active ? ' active' : ''}${dragging ? ' dragging' : ''}${color ? ' has-color' : ''}${dropSide ? ` drop-${dropSide}` : ''}`}
      style={color ? ({ '--tab-color': color } as CSSProperties) : undefined}
      title={tooltip}
      draggable={!renaming}
      onDragStart={(e) => {
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(TAB_MIME, tab.id);
        }
        useTabDrag.getState().start(tab.id, groupId);
      }}
      onDragOver={(e) => {
        if (!isTabDrag()) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const r = e.currentTarget.getBoundingClientRect();
        const side = r.width > 0 && e.clientX > r.left + r.width / 2 ? 'after' : 'before';
        const drag = useTabDrag.getState();
        if (drag.tabId === tab.id) drag.setOver(null);
        else drag.setOver({ kind: 'tab', groupId, tabId: tab.id, side });
      }}
      onDrop={(e) => {
        const { tabId, over } = useTabDrag.getState();
        if (!tabId) return;
        e.preventDefault();
        e.stopPropagation();
        if (tabId !== tab.id) applyStripDrop(tabId, groupId, over?.kind === 'tab' ? over : { kind: 'tab', groupId, tabId: tab.id, side: 'before' });
        useTabDrag.getState().end();
      }}
      onDragEnd={(e) => {
        const wasDragging = useTabDrag.getState().tabId === tab.id;
        useTabDrag.getState().end();
        // Dropped outside the window: open the tab in a window of its own, where it was dropped.
        if (wasDragging && isDragOutsideWindow({ clientX: e.clientX, clientY: e.clientY, dropEffect: e.dataTransfer?.dropEffect ?? 'none' }, window.innerWidth, window.innerHeight)
          && commandView('view.openInNewWindow', { kind: 'tab', tabId: tab.id }).enabled) {
          void detachTab(tab.id, { x: e.screenX, y: e.screenY });
        }
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          void closeTab(tab.id);
        } else if (e.button === 0) t.activate(tab.id);
      }}
      onDoubleClick={() => tab.kind === 'console' && runCommand('tab.rename', { kind: 'tab', tabId: tab.id })}
      onContextMenu={(e) => showContextMenu(e, contextMenu('tab', { kind: 'tab', tabId: tab.id }))}
    >
      {dropSide && <span className={`tab-drop-mark ${dropSide}`} aria-hidden />}
      <span className="tab-icon">
        <TabIcon tab={tab} providerId={conn?.providerId} />
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
