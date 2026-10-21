// Virtualized key list of the browser (docs/PLAN-M2.md 5.3): delimiter tree or flat list, type / TTL / memory badges,
// keyboard-first (arrows, Home/End, PageUp/Down, Right/Left open/close folders, Enter opens). Delete and F2 are
// commands of the `redisKeys` scope on this element. Only the visible rows render, so 100k keys stay fast.
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import { formatBytes, formatCount, formatTtl, TYPE_LABEL } from '../../redis/format';
import type { KeyTreeRow } from '../../redis/keyTree';
import { typeIcon, TYPE_COLOR } from './tree';

export const ROW_HEIGHT = 26;
const OVERSCAN = 12;

export interface KeyListHandle {
  focus(): void;
  scrollToKey(key: string): void;
}

interface KeyListProps {
  rows: KeyTreeRow[];
  selected: string | null;
  /** Key → expiry epoch ms (TTL countdown) */
  expiries: ReadonlyMap<string, number>;
  sizes: ReadonlyMap<string, number | null>;
  now: number;
  tree: boolean;
  onSelect: (key: string) => void;
  onToggle: (prefix: string, open?: boolean) => void;
  /** Visible key range changed (lazy memory badges). */
  onVisibleKeys: (keys: string[]) => void;
  onContextMenu?: (key: string, x: number, y: number) => void;
  empty?: string;
}

export const KeyList = forwardRef<KeyListHandle, KeyListProps>(function KeyList(
  { rows, selected, expiries, sizes, now, tree, onSelect, onToggle, onVisibleKeys, onContextMenu, empty },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || 600);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the cursor on the selected key when rows change
  useEffect(() => {
    if (!selected) return;
    const i = rows.findIndex((r) => r.kind === 'key' && r.entry.key === selected);
    if (i >= 0) setCursor(i);
  }, [rows, selected]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);
  const visibleKeyList = visible.filter((r) => r.kind === 'key').map((r) => (r as Extract<KeyTreeRow, { kind: 'key' }>).entry.key);
  const visibleSig = visibleKeyList.join('\u0001');
  useEffect(() => {
    onVisibleKeys(visibleSig ? visibleSig.split('\u0001') : []);
    // signature only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSig]);

  const scrollIntoView = (i: number) => {
    const el = scroller.current;
    if (!el) return;
    const top = i * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
    setScrollTop(el.scrollTop);
  };

  useImperativeHandle(ref, () => ({
    focus: () => scroller.current?.focus(),
    scrollToKey: (key: string) => {
      const i = rows.findIndex((r) => r.kind === 'key' && r.entry.key === key);
      if (i >= 0) {
        setCursor(i);
        scrollIntoView(i);
      }
    },
  }));

  const move = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setCursor(n);
    scrollIntoView(n);
    const r = rows[n];
    if (r?.kind === 'key') onSelect(r.entry.key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!rows.length) return;
    const r = rows[cursor];
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
    switch (e.key) {
      case 'ArrowDown': move(cursor + 1); break;
      case 'ArrowUp': move(cursor - 1); break;
      case 'PageDown': move(cursor + page); break;
      case 'PageUp': move(cursor - page); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'ArrowRight':
        if (r?.kind === 'folder') {
          if (!r.expanded) onToggle(r.prefix, true);
          else move(cursor + 1);
        }
        break;
      case 'ArrowLeft':
        if (r?.kind === 'folder' && r.expanded) onToggle(r.prefix, false);
        else if (r && r.depth > 0) {
          for (let i = cursor - 1; i >= 0; i--) {
            const p = rows[i];
            if (p.kind === 'folder' && p.depth === r.depth - 1) {
              move(i);
              break;
            }
          }
        }
        break;
      case 'Enter':
      case ' ':
        if (r?.kind === 'folder') onToggle(r.prefix);
        else if (r) onSelect(r.entry.key);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const active = rows[cursor];
  return (
    <div
      ref={scroller}
      className="redis-keylist"
      role="tree"
      aria-label="Keys"
      tabIndex={0}
      data-command-scope="redisKeys"
      aria-activedescendant={active ? `rk-${cursor}` : undefined}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      {!rows.length && <div className="redis-empty muted">{empty ?? 'No keys.'}</div>}
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        {visible.map((r, j) => {
          const i = first + j;
          const style = { top: i * ROW_HEIGHT, height: ROW_HEIGHT, paddingLeft: 8 + r.depth * 16 };
          if (r.kind === 'folder') {
            return (
              <div key={r.id} id={`rk-${i}`} role="treeitem" aria-expanded={r.expanded} aria-level={r.depth + 1} aria-selected={false}
                className={`redis-keyrow folder ${i === cursor ? 'cursor' : ''}`} style={style}
                onClick={() => { setCursor(i); onToggle(r.prefix); }}>
                {r.expanded ? <ChevronDown size={14} className="redis-twisty" /> : <ChevronRight size={14} className="redis-twisty" />}
                {r.expanded ? <FolderOpen size={14} className="redis-folder-icon" /> : <Folder size={14} className="redis-folder-icon" />}
                <span className="redis-keyname">{r.label}</span>
                <span className="redis-count tabular">{formatCount(r.count)}</span>
              </div>
            );
          }
          const k = r.entry;
          const exp = expiries.get(k.key);
          const ttl = exp === undefined ? k.ttl : Math.max(0, Math.ceil((exp - now) / 1000));
          const size = sizes.get(k.key) ?? k.size ?? null;
          return (
            <div key={r.id} id={`rk-${i}`} role="treeitem" aria-level={r.depth + 1} aria-selected={k.key === selected} title={k.key}
              className={`redis-keyrow ${k.key === selected ? 'selected' : ''} ${i === cursor ? 'cursor' : ''}`} style={style}
              onClick={() => { setCursor(i); onSelect(k.key); }}
              onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); setCursor(i); onSelect(k.key); onContextMenu(k.key, e.clientX, e.clientY); } }}>
              {tree && <span className="redis-twisty-spacer" />}
              <span className="redis-type-badge" style={{ color: TYPE_COLOR[k.type], borderColor: TYPE_COLOR[k.type] }}>{typeIcon(k.type, 12)}{TYPE_LABEL[k.type]}</span>
              <span className="redis-keyname mono">{tree ? r.label : k.key}</span>
              <span className={`redis-ttl tabular ${ttl >= 0 && ttl < 60 ? 'soon' : ''}`} aria-label={ttl >= 0 ? `TTL ${formatTtl(ttl)}` : 'No TTL'}>{ttl >= 0 ? formatTtl(ttl) : '–'}</span>
              <span className="redis-size tabular">{size !== null ? formatBytes(size) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
