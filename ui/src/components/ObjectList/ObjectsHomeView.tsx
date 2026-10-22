// The permanent Objects tab (home.ts): the objects of the explorer selection. A database / schema / folder / object
// shows the object list (ObjectList), a connection its databases or schemas as cards to drill into, nothing selected
// the welcome content. A breadcrumb walks back up; drilling down also selects the node in the explorer.
import { ChevronRight, Layers, LoaderCircle, MousePointerClick, Plug, Search, TriangleAlert, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ConnectionProfile } from '../../api/types';
import { catalogDatabase } from '../../app/actions';
import type { CommandTarget } from '../../commands/types';
import { dbKey, useCatalog } from '../../store/catalog';
import { hasDatabaseLevel, useConnection } from '../../store/connections';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { DatabaseIcon, PROVIDER_LABEL } from '../common/icons';
import { EmptyState } from '../EmptyState/EmptyState';
import { useExplorer } from '../Explorer/explorerStore';
import { databasesOf, nodeId } from '../Explorer/tree';
import type { TabViewProps } from '../layout/tabViews';
import { Welcome } from '../Onboarding/Welcome';
import { followSelection, groupForScope, homeScopeKey, homeStateOf, setHomeListOptions, type HomeTarget, type ObjectsHomeState } from './home';
import { ObjectList } from './ObjectListView';
import type { ObjectsState } from './open';
import './objectList.css';
import './objectsHome.css';

/** Select a node in the explorer (expanding its ancestors, focus untouched) and show it here right away. */
function drillTo(id: string, target: CommandTarget, ancestors: string[]): void {
  useExplorer.getState().selectNode(id, target, ancestors);
  followSelection(target);
}

const connNode = (cid: string) => ({ id: nodeId.conn(cid), target: { kind: 'connection', connectionId: cid } as CommandTarget, ancestors: [] as string[] });

export function ObjectsHomeView({ tab, visible }: TabViewProps) {
  const state = homeStateOf(tab);
  const t = state.target;
  const conn = useConnection(t?.connectionId);
  let body: ReactNode;
  if (!t || !conn) body = <HomeWelcome />;
  else if (t.kind === 'unsupported') body = <Unsupported conn={conn} />;
  else if (t.kind === 'connection') body = <ConnectionHome conn={conn} state={state} visible={visible} />;
  else body = <ScopeList conn={conn} target={t} state={state} visible={visible} />;
  return (
    <div className="oh-host" style={{ display: visible ? undefined : 'none' }} data-command-scope="objects">
      {body}
    </div>
  );
}

// ----------------------------------------------------------------------------------------------------- breadcrumb

interface Crumb {
  label: string;
  icon?: ReactNode;
  go?: () => void;
}

function Crumbs({ conn, items }: { conn: ConnectionProfile; items: Crumb[] }) {
  const all: Crumb[] = [
    { label: conn.name, icon: <ProviderLogo providerId={conn.providerId} size={14} />, go: items.length ? () => drillTo(connNode(conn.id).id, connNode(conn.id).target, []) : undefined },
    ...items,
  ];
  return (
    <nav className="oh-crumbs" aria-label="Location">
      <ol>
        {all.map((c, i) => (
          <li key={i}>
            {i > 0 && <ChevronRight size={12} className="oh-crumb-sep" aria-hidden="true" />}
            {c.go && i < all.length - 1 ? (
              <button type="button" className="oh-crumb" onClick={c.go} title={`Show ${c.label}`}>
                {c.icon}
                <span>{c.label}</span>
              </button>
            ) : (
              <span className="oh-crumb current" aria-current="location">
                {c.icon}
                <span>{c.label}</span>
              </span>
            )}
          </li>
        ))}
      </ol>
      <span className="oh-follow" title="This tab shows what is selected in the explorer">
        <MousePointerClick size={12} aria-hidden="true" /> Follows the explorer
      </span>
    </nav>
  );
}

// -------------------------------------------------------------------------------------------- database / schema

function ScopeList({ conn, target, state, visible }: { conn: ConnectionProfile; target: Extract<HomeTarget, { kind: 'scope' }>; state: ObjectsHomeState; visible: boolean }) {
  const { connectionId: cid, database, schema } = target;
  const key = homeScopeKey(target);
  const listState: ObjectsState = { connectionId: cid, database, schema, group: groupForScope(state, key), layout: state.layout, sort: state.sort };
  const shownDb = database ?? (conn.providerId === 'sqlite' ? null : catalogDatabase(cid, null));
  const dbLevel = hasDatabaseLevel(conn.providerId);
  const crumbs: Crumb[] = [];
  if (dbLevel && shownDb) {
    crumbs.push({
      label: shownDb,
      icon: <DatabaseIcon size={14} />,
      go: schema ? () => drillTo(nodeId.db(cid, database), { kind: 'container', connectionId: cid, database, schema: null }, [nodeId.conn(cid)]) : undefined,
    });
  }
  if (schema) crumbs.push({ label: schema, icon: <Layers size={14} aria-hidden="true" /> });
  return (
    <ObjectList
      key={key}
      state={listState}
      patch={(p) => setHomeListOptions(key, p)}
      visible={visible}
      highlight={state.highlight}
      header={<Crumbs conn={conn} items={crumbs} />}
    />
  );
}

// ------------------------------------------------------------------------------------------------- connection

interface Card {
  key: string;
  label: string;
  badge?: string;
  meta?: string;
  kind: 'database' | 'schema';
  node: { id: string; target: CommandTarget; ancestors: string[] };
}

/** A connection: its databases (or the schemas of its only database) as cards; a single schema lists its objects. */
function ConnectionHome({ conn, state, visible }: { conn: ConnectionProfile; state: ObjectsHomeState; visible: boolean }) {
  const cid = conn.id;
  const cat = useCatalog((s) => s.conns[cid]);
  const dbs = databasesOf(conn, cat);
  const single = dbs && dbs.length === 1 ? dbs[0] : undefined;
  const d = useCatalog((s) => (single === undefined ? undefined : s.dbs[dbKey(cid, single)]));

  useEffect(() => {
    if (single !== undefined && (!d || d.schemasStatus === 'idle')) void useCatalog.getState().loadSchemas(cid, single);
  }, [cid, single, d]);

  const connect = () => {
    useExplorer.getState().toggle(nodeId.conn(cid), true);
    void useCatalog.getState().loadDatabases(cid);
  };

  if (!cat || cat.status === 'idle') {
    return (
      <HomePanel conn={conn}>
        <EmptyState
          icon={<Plug size={28} strokeWidth={1.5} />}
          title={`${conn.name} is not connected`}
          hint="Connect to list its databases, schemas and objects here."
          action={{ label: 'Connect', onClick: connect }}
        />
      </HomePanel>
    );
  }
  if (cat.status === 'error') {
    return (
      <HomePanel conn={conn}>
        <EmptyState
          icon={<TriangleAlert size={28} strokeWidth={1.5} />}
          title={`Could not connect to ${conn.name}`}
          hint={cat.error ?? undefined}
          action={{ label: 'Try again', onClick: () => void useCatalog.getState().loadDatabases(cid, true) }}
        />
      </HomePanel>
    );
  }
  if (!dbs) return <HomePanel conn={conn}><Loading text="Connecting…" /></HomePanel>;

  if (dbs.length > 1) {
    const current = cat.databases?.current ?? null;
    const cards: Card[] = dbs.map((db) => ({
      key: `d:${db ?? ''}`,
      label: db ?? '(default)',
      badge: db === current ? 'current' : undefined,
      kind: 'database',
      node: { id: nodeId.db(cid, db), target: { kind: 'container', connectionId: cid, database: db, schema: null }, ancestors: [nodeId.conn(cid)] },
    }));
    return <HomePanel conn={conn}><CardGrid title="Databases" cards={cards} visible={visible} /></HomePanel>;
  }

  if (!d?.schemasResp) {
    if (d?.schemasStatus === 'error') {
      return (
        <HomePanel conn={conn}>
          <EmptyState icon={<TriangleAlert size={28} strokeWidth={1.5} />} title="Could not load the schemas" hint={d.schemasError ?? undefined}
            action={{ label: 'Try again', onClick: () => void useCatalog.getState().loadSchemas(cid, single ?? null, true) }} />
        </HomePanel>
      );
    }
    return <HomePanel conn={conn}><Loading text="Loading schemas…" /></HomePanel>;
  }
  const schemas = d.schemasResp.schemas;
  const db = single ?? null;
  if (schemas.length === 1) {
    // SQLite "main" and other single-schema connections: the objects right away.
    return <ScopeList conn={conn} target={{ kind: 'scope', connectionId: cid, database: db, schema: schemas[0].name }} state={state} visible={visible} />;
  }
  const def = d.schemasResp.defaultSchema;
  const sorted = [...schemas].sort((a, b) => (a.name === def ? -1 : b.name === def ? 1 : a.name.localeCompare(b.name)));
  const ancestors = [nodeId.conn(cid), ...(db !== null ? [nodeId.db(cid, db)] : [])];
  const cards: Card[] = sorted.map((s) => {
    const n = d.loaded[s.name]?.objects.length ?? s.objectCount ?? null;
    return {
      key: `s:${s.name}`,
      label: s.name,
      badge: s.name === def ? 'default' : undefined,
      meta: n === null ? undefined : `${n.toLocaleString('en-US')} object${n === 1 ? '' : 's'}`,
      kind: 'schema',
      node: { id: nodeId.schema(cid, db, s.name), target: { kind: 'container', connectionId: cid, database: db, schema: s.name }, ancestors },
    };
  });
  return <HomePanel conn={conn} db={db && hasDatabaseLevel(conn.providerId) ? db : null}><CardGrid title="Schemas" cards={cards} visible={visible} /></HomePanel>;
}

function HomePanel({ conn, db, children }: { conn: ConnectionProfile; db?: string | null; children: ReactNode }) {
  return (
    <div className="oh-view">
      <Crumbs conn={conn} items={db ? [{ label: db, icon: <DatabaseIcon size={14} /> }] : []} />
      <div className="oh-body">{children}</div>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="oh-loading" role="status">
      <LoaderCircle size={18} className="spin" aria-hidden="true" /> {text}
    </div>
  );
}

/** Cards to drill into: click selects, double-click / Enter drills down; typing filters. */
function CardGrid({ title, cards, visible }: { title: string; cards: Card[]; visible: boolean }) {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? cards.filter((c) => c.label.toLowerCase().includes(q)) : cards;
  }, [cards, query]);
  const index = sel ? shown.findIndex((c) => c.key === sel) : -1;

  useEffect(() => {
    if (index < 0) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(shown[index].key)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [index, shown]);

  const columns = () => {
    const el = gridRef.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first || !first.offsetWidth) return 1;
    return Math.max(1, Math.round(el.clientWidth / (first.offsetWidth + 10)));
  };
  const move = (i: number) => {
    if (!shown.length) return;
    setSel(shown[Math.max(0, Math.min(shown.length - 1, i))].key);
  };
  const drill = (c: Card) => drillTo(c.node.id, c.node.target, c.node.ancestors);

  const onKey = (e: KeyboardEvent) => {
    const i = index;
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); move(i + 1); break;
      case 'ArrowLeft': e.preventDefault(); move(i - 1); break;
      case 'ArrowDown': e.preventDefault(); move(i < 0 ? 0 : i + columns()); break;
      case 'ArrowUp': e.preventDefault(); if (i < columns()) filterRef.current?.focus(); else move(i - columns()); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(shown.length - 1); break;
      case 'Enter': if (i >= 0) { e.preventDefault(); drill(shown[i]); } break;
      case 'Escape': if (query) { e.preventDefault(); setQuery(''); } break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          e.preventDefault();
          setQuery(query + e.key);
          filterRef.current?.focus();
        }
    }
  };

  return (
    <div className="oh-cards-wrap" style={{ display: visible ? undefined : 'none' }}>
      <div className="oh-cards-head">
        <h2 className="oh-title">{title}<span className="oh-count">{cards.length.toLocaleString('en-US')}</span></h2>
        <span className="flex-1" />
        <div className="ol-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={filterRef}
            data-primary-focus
            className="ol-search-input"
            placeholder={`Filter ${title.toLowerCase()}`}
            aria-label={`Filter ${title.toLowerCase()}`}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
              else if (e.key === 'ArrowDown' || (e.key === 'Enter' && shown.length)) {
                e.preventDefault();
                if (e.key === 'Enter' && shown.length === 1) return drill(shown[0]);
                gridRef.current?.focus();
                move(index >= 0 ? index : 0);
              }
            }}
          />
          {query && (
            <button className="icon-btn xs" aria-label="Clear filter" title="Clear (Esc)" onClick={() => { setQuery(''); filterRef.current?.focus(); }}>
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      {shown.length === 0 ? (
        <EmptyState compact icon={<Search size={24} strokeWidth={1.5} />} title={`No ${title.toLowerCase()} match “${query}”`} action={{ label: 'Clear filter', onClick: () => setQuery('') }} />
      ) : (
        <div
          ref={gridRef}
          className="oh-cards"
          role="listbox"
          aria-label={title}
          tabIndex={0}
          aria-activedescendant={index >= 0 ? `oh-card-${index}` : undefined}
          onKeyDown={onKey}
          onFocus={() => { if (index < 0 && shown.length) setSel(shown[0].key); }}
        >
          {shown.map((c, i) => (
            <div
              key={c.key}
              id={`oh-card-${i}`}
              data-key={c.key}
              role="option"
              aria-selected={i === index}
              className={`ol-card oh-card${i === index ? ' selected' : ''}`}
              title={`${c.label}: double-click to show its objects`}
              onMouseDown={() => setSel(c.key)}
              onDoubleClick={() => drill(c)}
            >
              <span className={`ol-tile oh-tile-${c.kind}`}>
                {c.kind === 'database' ? <DatabaseIcon size={18} /> : <Layers size={18} aria-hidden="true" />}
              </span>
              <span className="ol-card-text">
                <span className="ol-card-name">{c.label}</span>
                <span className="ol-card-meta">
                  {c.badge && <span className="oh-badge">{c.badge}</span>}
                  {c.meta ?? (c.kind === 'database' ? 'Database' : 'Schema')}
                </span>
              </span>
              <ChevronRight size={14} className="oh-card-go" aria-hidden="true" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ other states

function Unsupported({ conn }: { conn: ConnectionProfile }) {
  return (
    <div className="oh-view">
      <Crumbs conn={conn} items={[]} />
      <div className="oh-body">
        <EmptyState
          icon={<ProviderLogo providerId={conn.providerId} size={32} />}
          title={`${conn.name} is a ${PROVIDER_LABEL[conn.providerId] ?? conn.providerId} connection`}
          hint="Its contents are browsed in the explorer. Select a SQL connection, database or schema to list its tables, views and routines here."
        />
      </div>
    </div>
  );
}

/** Nothing selected: the welcome content, with a line saying what this tab does. */
function HomeWelcome() {
  return (
    <div className="oh-view oh-welcome">
      <div className="oh-hint" role="note">
        <MousePointerClick size={14} aria-hidden="true" />
        Select a connection, database or schema in the explorer: its tables, views and routines are listed here.
      </div>
      <div className="oh-welcome-body">
        <Welcome ready />
      </div>
    </div>
  );
}
