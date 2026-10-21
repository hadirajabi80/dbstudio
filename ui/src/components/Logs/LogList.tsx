// Virtualized log entry list (docs/PLAN-M2.md 8.2): windowed absolutely positioned rows (24 px; expanded and wrapped
// rows are measured), listbox with aria-activedescendant and roving selection (Arrow keys, PgUp/PgDn, Home/End).
// Enter (expand), Space (pause) and Mod+C (copy) are registered commands scoped to `logsList`; Esc collapses the
// selected row (then the parent clears the search). Auto-scroll follows the bottom while tailing; scrolling up stops
// following and shows a "Jump to latest" pill.
import { ArrowDownToLine, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LogEntry } from '../../api/types';
import { getCommand } from '../../commands/registry';
import { withShortcut } from '../Shortcuts/Kbd';
import { formatTime, fullTime, highlight, LEVEL_LABEL } from './model';

export const ROW_H = 24;
/** jsdom and hidden tabs report 0: assume a typical viewport so the first rows still render. */
const FALLBACK_VIEW_H = 600;
const OVERSCAN = 8;

export interface LogListProps {
  entries: readonly LogEntry[];
  selectedSeq: number | null;
  onSelect(seq: number | null): void;
  expanded: ReadonlySet<number>;
  onToggleExpand(seq: number): void;
  wrap: boolean;
  pattern: RegExp | null;
  /** Follow the bottom (tailing and not scrolled up). */
  follow: boolean;
  onFollowChange(follow: boolean): void;
  tailing: boolean;
  onCopy(entry: LogEntry): void;
  /** Esc with nothing to collapse. */
  onEscape(): void;
  label: string;
  empty?: ReactNode;
  listRef?: (el: HTMLDivElement | null) => void;
}

function Highlighted({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;
  return (
    <>
      {highlight(text, pattern).map((s, i) => (s.hit ? <mark key={i} className="log-hit">{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  );
}

function firstLine(s: string): string {
  const i = s.search(/\r?\n/);
  return i < 0 ? s : `${s.slice(0, i)} …`;
}

/** Binary search: index of the row containing y. */
function rowAt(offsets: Float64Array, n: number, y: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

export function LogList(p: LogListProps) {
  const { entries, selectedSeq, expanded, wrap, follow } = p;
  const idBase = useId().replace(/:/g, '');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const [tick, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const n = entries.length;

  // Wrap changes every row's height: forget the measurements.
  useEffect(() => {
    heights.current.clear();
    setTick((t) => t + 1);
  }, [wrap]);

  const offsets = useMemo(() => {
    void tick;
    const o = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      o[i + 1] = o[i] + (wrap || expanded.has(e.seq) ? heights.current.get(e.seq) ?? ROW_H : ROW_H);
    }
    return o;
  }, [entries, n, wrap, expanded, tick]);
  const total = offsets[n];
  const vh = viewH || FALLBACK_VIEW_H;
  const start = n ? Math.max(0, rowAt(offsets, n, scrollTop) - OVERSCAN) : 0;
  const end = n ? Math.min(n, rowAt(offsets, n, scrollTop + vh) + 1 + OVERSCAN) : 0;
  const selIndex = useMemo(() => (selectedSeq == null ? -1 : entries.findIndex((e) => e.seq === selectedSeq)), [entries, selectedSeq]);

  const listRefProp = useRef(p.listRef);
  listRefProp.current = p.listRef;
  const setRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    listRefProp.current?.(el);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Measure wrapped / expanded rows after each render.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let changed = false;
    el.querySelectorAll<HTMLElement>('.log-row[data-measure]').forEach((row) => {
      const seq = Number(row.dataset.seq);
      const h = row.offsetHeight;
      if (h > 0 && heights.current.get(seq) !== h) {
        heights.current.set(seq, h);
        changed = true;
      }
    });
    if (changed) setTick((t) => t + 1);
  });

  // Follow the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow || !p.tailing) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [follow, p.tailing, total]);

  const scrollToIndex = (i: number) => {
    const el = scrollRef.current;
    if (!el || i < 0 || i >= n) return;
    const top = offsets[i];
    const bottom = offsets[i + 1];
    const h = el.clientHeight || FALLBACK_VIEW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + h) el.scrollTop = bottom - h;
    setScrollTop(el.scrollTop);
  };

  const select = (i: number) => {
    if (!n) return;
    const j = Math.max(0, Math.min(n - 1, i));
    p.onSelect(entries[j].seq);
    scrollToIndex(j);
    if (p.tailing) p.onFollowChange(j === n - 1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight || FALLBACK_VIEW_H) / ROW_H) - 1);
    const cur = selIndex < 0 ? (e.key === 'ArrowUp' || e.key === 'PageUp' ? n : -1) : selIndex;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': select(cur + 1); break;
      case 'ArrowUp': select(cur - 1); break;
      case 'PageDown': select(cur + page); break;
      case 'PageUp': select(cur - page); break;
      case 'Home': select(0); break;
      case 'End': select(n - 1); break;
      case 'Escape':
        if (selectedSeq != null && expanded.has(selectedSeq)) p.onToggleExpand(selectedSeq);
        else p.onEscape();
        break;
      default: handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (!p.tailing) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    if (follow !== atBottom) p.onFollowChange(atBottom);
  };

  const copyTitle = withShortcut('Copy entry', getCommand('logs.copyEntry')?.shortcut);
  const rows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const e = entries[i];
    const open = expanded.has(e.seq);
    const sel = e.seq === selectedSeq;
    const measured = wrap || open;
    rows.push(
      <div
        key={e.seq}
        id={`${idBase}-r${e.seq}`}
        role="option"
        aria-selected={sel}
        aria-expanded={open}
        data-seq={e.seq}
        data-measure={measured || undefined}
        className={`log-row lvl-${e.level}${sel ? ' selected' : ''}${open ? ' expanded' : ''}${wrap ? ' wrap' : ''}`}
        style={{ top: offsets[i], height: measured ? undefined : ROW_H }}
        onMouseDown={(ev) => {
          if (ev.button !== 0) return;
          p.onSelect(e.seq);
        }}
        onDoubleClick={() => p.onToggleExpand(e.seq)}
      >
        <div className="log-line">
          <span
            className="log-twisty"
            aria-hidden="true"
            onMouseDown={(ev) => {
              ev.stopPropagation();
              p.onSelect(e.seq);
              p.onToggleExpand(e.seq);
            }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <span className="log-time tabular" title={fullTime(e.ts)}>{formatTime(e.ts)}</span>
          <span className={`log-level lvl-${e.level}`}>{LEVEL_LABEL[e.level]}</span>
          <span className="log-source" title={e.source}>{e.source}</span>
          <span className="log-msg">
            <Highlighted text={wrap ? e.message : firstLine(e.message)} pattern={p.pattern} />
          </span>
        </div>
        {open && (
          <div className="log-detail">
            <pre className="log-detail-text"><Highlighted text={e.message} pattern={p.pattern} /></pre>
            {e.detail && <pre className="log-detail-text muted"><Highlighted text={e.detail} pattern={p.pattern} /></pre>}
            {e.fields && Object.keys(e.fields).length > 0 && (
              <table className="details-table log-fields">
                <tbody>
                  {Object.entries(e.fields).map(([k, v]) => (
                    <tr key={k}>
                      <th scope="row">{k}</th>
                      <td className="mono">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="log-detail-actions">
              <span className="muted">{fullTime(e.ts)} · seq {e.seq}</span>
              <button type="button" className="btn btn-xs" tabIndex={-1} title={copyTitle} onClick={() => p.onCopy(e)}>
                <Copy size={12} /> Copy
              </button>
            </div>
          </div>
        )}
      </div>,
    );
  }

  return (
    <div className="log-list-wrap">
      <div
        ref={setRef}
        className="log-list"
        role="listbox"
        aria-label={p.label}
        aria-activedescendant={selectedSeq != null && selIndex >= 0 ? `${idBase}-r${selectedSeq}` : undefined}
        tabIndex={0}
        data-primary-focus
        data-command-scope="logsList"
        data-logs-list
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onFocus={(e) => {
          if (e.target === e.currentTarget && selectedSeq == null && n && !p.tailing) p.onSelect(entries[n - 1].seq);
        }}
      >
        <div className="log-list-inner" style={{ height: total }}>
          {rows}
        </div>
      </div>
      {n === 0 && p.empty && <div className="log-list-empty">{p.empty}</div>}
      {p.tailing && !follow && n > 0 && (
        <button type="button" className="log-jump pill" onClick={() => p.onFollowChange(true)}>
          <ArrowDownToLine size={12} /> Jump to latest
        </button>
      )}
    </div>
  );
}
