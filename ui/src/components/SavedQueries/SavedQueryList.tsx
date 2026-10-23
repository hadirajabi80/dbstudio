// The Objects tab's "Queries" group (Navicat's Queries node): the queries saved into the schema (or into every schema
// of the database), as a sortable list, cards or small tiles. Enter / double-click opens one in a console bound to it;
// F2 renames, Delete deletes; the context menu is the explorer's.
import {
  ArrowDown, ArrowUp, ChevronDown, Copy, FileCode2, FolderOpen, Grid3x3, LayoutGrid, List, LoaderCircle, Plus, RefreshCw, Search, SearchX, TextCursorInput,
  Trash2, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { SavedQuery } from '../../api/savedQueries';
import { runCommand } from '../../commands/registry';
import { displayShortcut } from '../../commands/keys';
import { queriesIn, scopeLabel, useSavedQueries } from '../../store/savedQueries';
import { showContextMenu } from '../common/Menu';
import { EmptyState } from '../EmptyState/EmptyState';
import { contextMenu } from '../layout/commandMenu';
import { filterQueries, formatQueryDate, sortQueries, targetOfQuery, type QuerySortKey } from './model';
import './savedQueries.css';

/** The Objects tab's sort spec (keys shared with the object list: `comment` is the description). */
export interface QueryListSort {
  key: string;
  dir: 'asc' | 'desc';
}

export interface SavedQueryListProps {
  connectionId: string;
  /** The database as the catalog keys it (null on Oracle). */
  database: string | null;
  /** null: every schema of the database. */
  schema: string | null;
  layout: string;
  onLayout(layout: 'list' | 'grid' | 'compact'): void;
  sort: QueryListSort;
  onSort(sort: QueryListSort): void;
  visible: boolean;
  /** The Objects tab's breadcrumb. */
  header?: ReactNode;
  /** The type group strip (All, Tables…, Queries). */
  groupTabs: ReactNode;
  /** Opens the toolbar's New menu (object list entries + New query) under the button. */
  onNewMenu(el: HTMLElement): void;
}

const SORT_KEY: Record<string, QuerySortKey> = { name: 'name', schema: 'schema', modified: 'modified', comment: 'description' };

export function SavedQueryList({ connectionId: cid, database, schema, layout, onLayout, sort, onSort, visible, header, groupTabs, onNewMenu }: SavedQueryListProps) {
  const entry = useSavedQueries((s) => s.byConn[cid]);
  useEffect(() => {
    void useSavedQueries.getState().ensure(cid);
  }, [cid]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => queriesIn(entry?.items, database, schema), [entry?.items, database, schema]);
  const sortKey = SORT_KEY[sort.key] ?? 'name';
  const shown = useMemo(() => sortQueries(filterQueries(all, query), sortKey, SORT_KEY[sort.key] ? sort.dir : 'asc'), [all, query, sortKey, sort.key, sort.dir]);
  const current = shown.find((q) => q.id === selected) ?? null;
  const index = current ? shown.indexOf(current) : -1;
  const multiSchema = schema === null;
  const where = scopeLabel({ database, schema });
  const mode = layout === 'grid' || layout === 'compact' ? layout : 'list';
  const loading = !entry || entry.status === 'loading';

  const open = (q: SavedQuery) => runCommand('queries.open', targetOfQuery(q));
  const menuAt = (q: SavedQuery, pos: { clientX: number; clientY: number; preventDefault?: () => void }) => {
    setSelected(q.id);
    const items = contextMenu('explorer.savedQuery', targetOfQuery(q));
    if (items.length) showContextMenu(pos, items);
    else pos.preventDefault?.();
  };
  const move = (i: number) => {
    if (!shown.length) return;
    const q = shown[Math.max(0, Math.min(shown.length - 1, i))];
    setSelected(q.id);
    bodyRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(q.id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  };
  const cols = () => {
    if (mode === 'list') return 1;
    const items = bodyRef.current?.querySelectorAll<HTMLElement>('[data-key]');
    if (!items || items.length < 2) return 1;
    const top = items[0].offsetTop;
    let n = 0;
    for (const el of items) if (el.offsetTop === top) n++;
    return Math.max(1, n);
  };

  const onBodyKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = cols();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(index < 0 ? 0 : index + step); break;
      case 'ArrowUp': e.preventDefault(); if (index <= 0 && mode === 'list') searchRef.current?.focus(); else move(index - step); break;
      case 'ArrowRight': if (mode !== 'list') { e.preventDefault(); move(index + 1); } break;
      case 'ArrowLeft': if (mode !== 'list') { e.preventDefault(); move(index - 1); } break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(shown.length - 1); break;
      case 'Enter': if (current) { e.preventDefault(); open(current); } break;
      case 'F2': if (current) { e.preventDefault(); runCommand('queries.rename', targetOfQuery(current)); } break;
      case 'Delete': if (current) { e.preventDefault(); runCommand('queries.delete', targetOfQuery(current)); } break;
      case 'F10':
      case 'ContextMenu': {
        if (!current || (e.key === 'F10' && !e.shiftKey)) break;
        e.preventDefault();
        const r = bodyRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(current.id)}"]`)?.getBoundingClientRect();
        menuAt(current, { clientX: (r?.left ?? 0) + 40, clientY: r?.bottom ?? 0 });
        break;
      }
      case 'Escape': if (query) { e.preventDefault(); setQuery(''); } break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          e.preventDefault();
          setQuery(query + e.key);
          searchRef.current?.focus();
        }
    }
  };

  const itemProps = (q: SavedQuery) => ({
    'data-key': q.id,
    role: 'option',
    'aria-selected': q.id === selected,
    onMouseDown: () => setSelected(q.id),
    onDoubleClick: () => open(q),
    onContextMenu: (e: ReactMouseEvent) => menuAt(q, e),
  });

  const columns: { key: string; label: string; width: string; render(q: SavedQuery): ReactNode }[] = [
    {
      key: 'name', label: 'Name', width: 'minmax(200px, 2fr)',
      render: (q) => (
        <span className="ol-name">
          <FileCode2 size={15} strokeWidth={1.5} className="obj-icon obj-query" aria-hidden="true" />
          <span className="ol-name-text" title={q.name}>{q.name}</span>
        </span>
      ),
    },
    ...(multiSchema ? [{ key: 'schema', label: 'Schema', width: 'minmax(90px, 0.7fr)', render: (q: SavedQuery) => <span className="ol-muted">{q.schema}</span> }] : []),
    { key: 'modified', label: 'Modified', width: '138px', render: (q) => <span className="ol-muted" title={`Created ${formatQueryDate(q.createdAt)}`}>{formatQueryDate(q.updatedAt)}</span> },
    { key: 'comment', label: 'Description', width: 'minmax(160px, 2.4fr)', render: (q) => <span className="ol-comment" title={q.description ?? undefined}>{q.description}</span> },
  ];
  const template = columns.map((c) => c.width).join(' ');

  const firstLine = (sql: string) => sql.trim().split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

  const body = (() => {
    if (!shown.length && loading) {
      return (
        <div className="ol-skeleton" role="status" aria-label="Loading queries">
          {[64, 48, 70].map((w, i) => (
            <div key={i} className="ol-skeleton-row">
              <span className="ol-skeleton-icon" />
              <span className="ol-skeleton-bar" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      );
    }
    if (!shown.length) {
      if (entry?.status === 'error') {
        return <EmptyState compact icon={<FileCode2 size={26} strokeWidth={1.5} />} title="Could not load the saved queries" hint={entry.error ?? undefined} action={{ label: 'Try again', onClick: () => void useSavedQueries.getState().load(cid) }} />;
      }
      if (query) {
        return <EmptyState compact icon={<SearchX size={26} strokeWidth={1.5} />} title={`No queries match “${query}”`} action={{ label: 'Clear filter', onClick: () => setQuery('') }} />;
      }
      return (
        <EmptyState
          icon={<FileCode2 size={28} strokeWidth={1.5} />}
          title={`No saved queries in ${where}`}
          hint={`Save a console here with Save query to schema… (${displayShortcut('Mod+Alt+S')}), or create one.`}
          action={{ command: 'queries.new', args: { kind: 'container', connectionId: cid, database, schema, queries: true } }}
        />
      );
    }
    if (mode === 'grid') {
      return (
        <div className="sq-cards">
          {shown.map((q) => (
            <div key={q.id} {...itemProps(q)} className={`ol-card${q.id === selected ? ' selected' : ''}`} title={`${q.name}${q.description ? `\n${q.description}` : ''}\n\n${q.sql.slice(0, 400)}`}>
              <span className="ol-tile ol-tint-queries">
                <FileCode2 size={18} strokeWidth={1.5} className="obj-icon obj-query" aria-hidden="true" />
              </span>
              <span className="ol-card-text">
                <span className="ol-card-name">{q.name}</span>
                <span className="ol-card-meta">
                  {multiSchema && q.schema ? <span className="ol-card-schema">{q.schema}</span> : null}
                  {q.description ? <span>{q.description}</span> : <span className="sq-card-sql">{firstLine(q.sql) || 'Empty query'}</span>}
                </span>
              </span>
            </div>
          ))}
        </div>
      );
    }
    if (mode === 'compact') {
      return (
        <div className="sq-tiles">
          {shown.map((q) => (
            <div key={q.id} {...itemProps(q)} className={`sq-mini${q.id === selected ? ' selected' : ''}`} title={`${q.name}${q.description ? `\n${q.description}` : ''}`}>
              <FileCode2 size={14} strokeWidth={1.5} className="obj-icon obj-query" aria-hidden="true" />
              <span className="sq-mini-name">
                {multiSchema && q.schema ? <span className="sq-mini-schema">{q.schema}.</span> : null}
                {q.name}
              </span>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="sq-rows">
        {shown.map((q) => (
          <div key={q.id} {...itemProps(q)} className={`ol-row${q.id === selected ? ' selected' : ''}`} style={{ gridTemplateColumns: template }}>
            {columns.map((c) => <span key={c.key} className="ol-cell">{c.render(q)}</span>)}
          </div>
        ))}
      </div>
    );
  })();

  const n = (k: number) => `${k.toLocaleString('en-US')} ${k === 1 ? 'query' : 'queries'}`;
  const target = current ? targetOfQuery(current) : null;

  return (
    <div className="ol-view" style={{ display: visible ? undefined : 'none' }} data-command-scope="objects">
      {header}
      <div className="ol-toolbar" role="toolbar" aria-label="Saved queries">
        <button className="btn btn-xs" aria-haspopup="menu" onClick={(e) => onNewMenu(e.currentTarget)} title="Create a query or an object in this schema">
          <Plus size={13} /> New <ChevronDown size={11} />
        </button>
        <span className="ol-sep" aria-hidden="true" />
        <button className="btn btn-xs" disabled={!current} onClick={() => current && open(current)} title="Open in a console (Enter)">
          <FolderOpen size={13} /> Open
        </button>
        <button className="btn btn-xs" disabled={!target} onClick={() => target && runCommand('queries.rename', target)} title="Rename the query (F2)">
          <TextCursorInput size={13} /> Rename
        </button>
        <button className="btn btn-xs" disabled={!target} onClick={() => target && runCommand('queries.duplicate', target)} title="Duplicate the query">
          <Copy size={13} /> Duplicate
        </button>
        <button className="icon-btn sm" disabled={!target} onClick={() => target && runCommand('queries.delete', target)} title="Delete the query (Delete)" aria-label="Delete query">
          <Trash2 size={14} />
        </button>
        <div className="flex-1" />
        <div className="ol-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            data-primary-focus
            className="ol-search-input"
            placeholder="Filter queries"
            aria-label="Filter queries"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
              else if (e.key === 'ArrowDown' || (e.key === 'Enter' && shown.length)) {
                e.preventDefault();
                if (e.key === 'Enter' && shown.length === 1) return void open(shown[0]);
                bodyRef.current?.focus();
                move(index >= 0 ? index : 0);
              }
            }}
          />
          {query && (
            <button className="icon-btn xs" aria-label="Clear search" title="Clear (Esc)" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>
              <X size={12} />
            </button>
          )}
        </div>
        <div className="ol-layout" role="group" aria-label="Layout">
          <button className={mode === 'list' ? 'on' : ''} aria-pressed={mode === 'list'} title="List" aria-label="List" onClick={() => onLayout('list')}>
            <List size={14} />
          </button>
          <button className={mode === 'grid' ? 'on' : ''} aria-pressed={mode === 'grid'} title="Cards" aria-label="Cards" onClick={() => onLayout('grid')}>
            <LayoutGrid size={14} />
          </button>
          <button className={mode === 'compact' ? 'on' : ''} aria-pressed={mode === 'compact'} title="Small icons" aria-label="Small icons" onClick={() => onLayout('compact')}>
            <Grid3x3 size={14} />
          </button>
        </div>
        <button className="icon-btn sm" title="Refresh" aria-label="Refresh" onClick={() => void useSavedQueries.getState().load(cid)}>
          {entry?.status === 'loading' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      {groupTabs}

      {mode === 'list' && shown.length > 0 && (
        <div className="ol-head" role="row" style={{ gridTemplateColumns: template }}>
          {columns.map((c) => {
            const on = sort.key === c.key || (c.key === 'name' && !SORT_KEY[sort.key]);
            const dir = SORT_KEY[sort.key] ? sort.dir : 'asc';
            return (
              <button
                key={c.key}
                role="columnheader"
                aria-sort={on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                className={`ol-head-cell${on ? ' on' : ''}`}
                onClick={() => onSort(on ? { key: c.key, dir: dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.key === 'modified' ? 'desc' : 'asc' })}
              >
                {c.label}
                {on && (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
              </button>
            );
          })}
        </div>
      )}

      <div
        ref={bodyRef}
        className={`ol-body ol-${mode}`}
        role="listbox"
        aria-label={`Saved queries of ${where}`}
        tabIndex={0}
        onKeyDown={onBodyKey}
        onFocus={() => { if (index < 0 && shown.length) setSelected(shown[0].id); }}
      >
        {body}
      </div>

      <div className="ol-status">
        <span>{entry?.status === 'ready' || all.length ? (shown.length === all.length ? n(all.length) : `${shown.length.toLocaleString('en-US')} of ${n(all.length)}`) : 'Loading…'}</span>
        <span className="ol-muted">{where}</span>
        <div className="flex-1" />
        {current && <span className="ol-muted mono">{current.schema && multiSchema ? `${current.schema}.` : ''}{current.name}</span>}
      </div>
    </div>
  );
}
