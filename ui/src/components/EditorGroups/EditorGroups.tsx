// The workspace's editor groups (split editor). Every group has its own tab strip; the tab bodies of all groups are
// siblings in one container, positioned over their group's area, so moving a tab to another group never remounts
// it (the Monaco editor, the grid and the view keep their state; Monaco and the grid follow the new size through
// their resize observers).
import { useMemo, useRef, type CSSProperties, type DragEvent, type ReactNode, type RefObject } from 'react';
import {
  computeLayout, dropZoneAt, MAX_GROUPS, resizeSizes, setSplitSizes, splitSizesAt, zoneRect, type DropZone, type EditorGroup, type Rect,
  type SplitterInfo,
} from '../../store/editorGroups';
import { useTabs, type Tab } from '../../store/tabs';
import type { EffectiveTheme } from '../../theme/useTheme';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Splitter } from '../common/Splitter';
import { ConsoleView } from '../layout/ConsoleView';
import { TabBar } from '../layout/TabBar';
import { TabErrorBoundary, ViewTabHost } from '../layout/ViewTabHost';
import { ObjectTabView } from '../ObjectTab/ObjectTab';
import { useTabDrag } from './dnd';
import './editorGroups.css';

const pct = (f: number) => `${+(f * 100).toFixed(4)}%`;

function headerStyle(r: Rect): CSSProperties {
  return { left: pct(r.x), top: pct(r.y), width: pct(r.w) };
}

function bodyStyle(r: Rect): CSSProperties {
  return { left: pct(r.x), top: `calc(${pct(r.y)} + var(--tabbar-h))`, width: pct(r.w), height: `calc(${pct(r.h)} - var(--tabbar-h))` };
}

export function EditorGroups({ theme }: { theme: EffectiveTheme }) {
  const tabs = useTabs((s) => s.tabs);
  const groups = useTabs((s) => s.groups);
  const layout = useTabs((s) => s.layout);
  const focused = useTabs((s) => s.focusedGroup);
  const dragging = useTabDrag((s) => s.tabId !== null);
  const ref = useRef<HTMLDivElement>(null);
  const { rects, splitters } = useMemo(() => computeLayout(layout), [layout]);
  const owner = useMemo(() => {
    const m = new Map<string, EditorGroup>();
    for (const g of groups) for (const id of g.tabIds) m.set(id, g);
    return m;
  }, [groups]);
  const multi = groups.length > 1;
  const fallback = groups[0];

  return (
    <div className={`editor-groups${multi ? ' multi' : ''}${dragging ? ' tab-dragging' : ''}`} ref={ref} data-groups={groups.length}>
      {groups.map((g) => (
        <div
          key={g.id}
          className={`eg-header${g.id === focused ? ' focused' : ''}`}
          style={headerStyle(rects[g.id] ?? { x: 0, y: 0, w: 1, h: 1 })}
          data-group={g.id}
          onMouseDown={(e) => {
            if (e.button === 0 && useTabs.getState().focusedGroup !== g.id) useTabs.getState().focusGroup(g.id);
          }}
        >
          <ErrorBoundary area="the tab strip" variant="strip">
            <TabBar groupId={g.id} />
          </ErrorBoundary>
        </div>
      ))}
      {tabs.map((t) => {
        const g = owner.get(t.id) ?? fallback;
        const visible = g?.activeId === t.id;
        return (
          <TabSlot key={t.id} tab={t} rect={rects[g?.id ?? ''] ?? { x: 0, y: 0, w: 1, h: 1 }} visible={visible} groupId={g?.id ?? ''}>
            <TabBody tab={t} theme={theme} visible={visible} />
          </TabSlot>
        );
      })}
      {splitters.map((sp) => (
        <GroupSplitter key={`${sp.path.join('.')}:${sp.index}`} info={sp} container={ref} />
      ))}
      {dragging && groups.map((g) => <DropOverlay key={g.id} group={g} rect={rects[g.id] ?? { x: 0, y: 0, w: 1, h: 1 }} groupCount={groups.length} />)}
    </div>
  );
}

/** One tab's body, placed over its group's area. Focus or a click inside it focuses the group. */
function TabSlot({ tab, rect, visible, groupId, children }: { tab: Tab; rect: Rect; visible: boolean; groupId: string; children: ReactNode }) {
  const focusMe = () => {
    if (visible && useTabs.getState().activeId !== tab.id) useTabs.getState().activate(tab.id);
  };
  return (
    <div
      className="workspace-body eg-slot"
      data-group={groupId}
      data-slot={tab.id}
      style={{ ...bodyStyle(rect), display: visible ? undefined : 'none' }}
      onMouseDownCapture={focusMe}
      onFocusCapture={focusMe}
    >
      {children}
    </div>
  );
}

function TabBody({ tab, theme, visible }: { tab: Tab; theme: EffectiveTheme; visible: boolean }) {
  if (tab.kind === 'console') {
    return (
      <TabErrorBoundary tab={tab} visible={visible}>
        <ConsoleView tab={tab} theme={theme} visible={visible} />
      </TabErrorBoundary>
    );
  }
  if (tab.kind === 'object') {
    return (
      <div className="view-tab-host" data-tab-host={tab.id} style={{ display: visible ? 'contents' : 'none' }}>
        <TabErrorBoundary tab={tab} visible={visible}>
          <ObjectTabView tab={tab} theme={theme} visible={visible} />
        </TabErrorBoundary>
      </div>
    );
  }
  return <ViewTabHost tab={tab} theme={theme} visible={visible} />;
}

/** Drag handle between two groups; double-click shares the space equally. */
function GroupSplitter({ info, container }: { info: SplitterInfo; container: RefObject<HTMLDivElement> }) {
  const base = useRef<{ sizes: number[]; px: number } | null>(null);
  const vertical = info.dir === 'row';
  const r = info.splitRect;
  const style: CSSProperties = vertical
    ? { left: pct(info.at), top: pct(r.y), height: pct(r.h) }
    : { top: pct(info.at), left: pct(r.x), width: pct(r.w) };
  return (
    <div className={`eg-splitter ${vertical ? 'vertical' : 'horizontal'}`} style={style}>
      <Splitter
        direction={vertical ? 'vertical' : 'horizontal'}
        ariaLabel={vertical ? 'Resize editor groups (left | right)' : 'Resize editor groups (top / bottom)'}
        onDragStart={() => {
          const el = container.current;
          const sizes = splitSizesAt(useTabs.getState().layout, info.path);
          if (!el || !sizes) return;
          const box = el.getBoundingClientRect();
          base.current = { sizes, px: Math.max(1, vertical ? box.width * r.w : box.height * r.h) };
        }}
        onDrag={(delta) => {
          const b = base.current;
          if (!b) return;
          const sizes = resizeSizes(b.sizes, info.index, delta / b.px);
          useTabs.getState().setGroupLayout(setSplitSizes(useTabs.getState().layout, info.path, sizes));
        }}
        onDragEnd={() => {
          base.current = null;
        }}
        onDoubleClick={() => {
          const sizes = splitSizesAt(useTabs.getState().layout, info.path);
          if (sizes) useTabs.getState().setGroupLayout(setSplitSizes(useTabs.getState().layout, info.path, sizes.map(() => 1 / sizes.length)));
        }}
      />
    </div>
  );
}

const ZONE_LABEL: Record<DropZone, string> = {
  left: 'Split left', right: 'Split right', up: 'Split up', down: 'Split down', center: 'Move to this group',
};

/** Drop target over a group's body while a tab is dragged: edges split, the middle moves the tab into the group. */
function DropOverlay({ group, rect, groupCount }: { group: EditorGroup; rect: Rect; groupCount: number }) {
  const over = useTabDrag((s) => (s.over?.kind === 'zone' && s.over.groupId === group.id ? s.over.zone : null));
  // The highlight keeps its last zone while fading out, and slides between zones (CSS transitions).
  const last = useTabDrag((s) => s.lastZones[group.id]);
  const shown = over ?? last ?? 'center';

  const zoneFor = (e: DragEvent<HTMLDivElement>): DropZone | null => {
    const { tabId, fromGroup } = useTabDrag.getState();
    if (!tabId) return null;
    const own = fromGroup === group.id || group.tabIds.includes(tabId);
    const r = e.currentTarget.getBoundingClientRect();
    const frac = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);
    const x = frac(r.width ? (e.clientX - r.left) / r.width : NaN);
    const y = frac(r.height ? (e.clientY - r.top) / r.height : NaN);
    // A group's only tab cannot split off its own group, and there is no room for another group at the maximum.
    const allowSplit = groupCount < MAX_GROUPS && !(own && group.tabIds.length < 2);
    const z = dropZoneAt(x, y, allowSplit);
    if (z === 'center' && own) return null;
    return z;
  };

  return (
    <div
      className="eg-drop"
      style={bodyStyle(rect)}
      data-drop-group={group.id}
      onDragOver={(e) => {
        const z = zoneFor(e);
        if (!z) {
          useTabDrag.getState().setOver(null);
          return;
        }
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        useTabDrag.getState().setOver({ kind: 'zone', groupId: group.id, zone: z });
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        const o = useTabDrag.getState().over;
        if (o?.kind === 'zone' && o.groupId === group.id) useTabDrag.getState().setOver(null);
      }}
      onDrop={(e) => {
        const { tabId } = useTabDrag.getState();
        const z = zoneFor(e);
        e.preventDefault();
        useTabDrag.getState().end();
        if (!tabId || !z) return;
        if (z === 'center') useTabs.getState().moveTab(tabId, group.id);
        else useTabs.getState().splitTab(tabId, z, group.id);
        useTabs.getState().requestFocus(tabId);
      }}
    >
      <div className={`eg-drop-zone zone-${shown}${over ? ' on' : ''}`} style={zoneStyle(shown)} aria-hidden>
        <span className="eg-drop-label">{ZONE_LABEL[shown]}</span>
      </div>
    </div>
  );
}

function zoneStyle(zone: DropZone): CSSProperties {
  // Inset by a few pixels so the highlight reads as a card inside the group.
  const z = zoneRect(zone);
  const gap = 'var(--space-1)';
  return {
    left: `calc(${pct(z.x)} + ${gap})`, top: `calc(${pct(z.y)} + ${gap})`,
    width: `calc(${pct(z.w)} - 2 * ${gap})`, height: `calc(${pct(z.h)} - 2 * ${gap})`,
  };
}
