// Dependencies section of the object tab (WP3): what the object uses and what uses it, side by side, grouped (FKs,
// tables, views, routines, triggers), with a summary strip on top. A row opens that object; right-click gives the
// explorer's menu. Loaded when the section is first shown and cached per tab.
import { ArrowDownLeft, ArrowUpRight, LoaderCircle, Network, RefreshCw, TriangleAlert, Waypoints } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../api/client';
import { objectsApi } from '../../api/objectsClient';
import type { CatalogObjectType, Dialect, ObjectRef } from '../../api/types';
import type { DependencyGraph, ObjectDependency } from '../../api/types.objects';
import { openObject } from '../../app/actions';
import type { ObjectTarget } from '../../commands/types';
import { commandView, useCommandsVersion } from '../../commands/useCommands';
import { OBJECT_TYPE_SINGULAR } from '../../lib/sql';
import { ObjectIcon } from '../common/icons';
import { showContextMenu } from '../common/Menu';
import { EmptyState } from '../EmptyState/EmptyState';
import { contextMenu } from '../layout/commandMenu';
import {
  badgeOf, cachedDependencies, categoryOf, dependencyKey, groupDependencies, rememberDependencies, splitFkDetail, summaryChips, type DepCategory,
} from './model';
import './dependencies.css';


const ROUTINES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc', 'package', 'trigger']);

function menuIdOf(t: CatalogObjectType): string {
  if (t === 'table') return 'explorer.table';
  if (t === 'view' || t === 'mview') return 'explorer.view';
  return ROUTINES.has(t) ? 'explorer.routine' : 'explorer.object';
}

interface Props {
  /** Cache slot (the object tab id). */
  cacheId: string;
  connectionId: string;
  database: string | null;
  objectRef: ObjectRef;
  dialect: Dialect;
  onLoaded?: (graph: DependencyGraph) => void;
}

export function DependenciesPanel({ cacheId, connectionId, database, objectRef: ref, dialect, onLoaded }: Props) {
  useCommandsVersion(); // enablement of the toolbar commands (registry changes only; this view does not follow executions)
  const key = dependencyKey(connectionId, database, ref);
  const [graph, setGraph] = useState<DependencyGraph | null>(() => cachedDependencies(cacheId, key));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!graph);
  const [nonce, setNonce] = useState(0);

  const load = useCallback((signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    objectsApi.dependencies(connectionId, database, ref, signal)
      .then((g) => {
        rememberDependencies(cacheId, key, g);
        setGraph(g);
        onLoaded?.(g);
      })
      .catch((e) => {
        if (!signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
  }, [connectionId, database, ref, cacheId, key, onLoaded]);

  useEffect(() => {
    if (nonce === 0 && cachedDependencies(cacheId, key)) return;
    const ctl = new AbortController();
    load(ctl.signal);
    return () => ctl.abort();
  }, [nonce, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = () => setNonce((n) => n + 1);
  const target: ObjectTarget = { kind: 'object', connectionId, database, ref };
  const er = ref.type === 'table' ? commandView('er.openRelated', target, 'Open in ER diagram') : null;
  const name = ref.name;

  if (!graph) {
    if (error) {
      return (
        <div className="deps">
          <EmptyState
            icon={<TriangleAlert size={28} strokeWidth={1.5} />}
            title="Could not read the dependencies"
            hint={error}
            action={{ label: 'Try again', onClick: reload }}
          />
        </div>
      );
    }
    return (
      <div className="deps deps-loading" role="status" aria-label="Loading dependencies">
        <LoaderCircle size={16} className="spin" /> Reading dependencies…
      </div>
    );
  }

  const chips = summaryChips(graph);
  const empty = graph.uses.length + graph.usedBy.length === 0;
  const open = (d: ObjectDependency) => openObject(connectionId, d.object.database ?? database, { ...d.object, database: d.object.database ?? database });
  const menu = (d: ObjectDependency, e: { clientX: number; clientY: number; preventDefault?: () => void }) => {
    const items = contextMenu(menuIdOf(d.object.type), { kind: 'object', connectionId, database, ref: { ...d.object, database: d.object.database ?? database } });
    if (items.length) showContextMenu(e, items);
    else e.preventDefault?.();
  };

  return (
    <div className="deps">
      <div className="deps-summary">
        <div className="deps-stat uses">
          <ArrowUpRight size={15} aria-hidden="true" />
          <span className="deps-stat-label">Uses</span>
          <span className="deps-stat-n">{graph.uses.length}</span>
        </div>
        <div className="deps-root" title={`${graph.root.schema ? `${graph.root.schema}.` : ''}${graph.root.name}`}>
          <ObjectIcon type={graph.root.type} size={15} />
          <span className="deps-root-name">{name}</span>
          <span className="deps-root-type">{OBJECT_TYPE_SINGULAR[graph.root.type]}</span>
        </div>
        <div className="deps-stat used">
          <ArrowDownLeft size={15} aria-hidden="true" />
          <span className="deps-stat-label">Used by</span>
          <span className="deps-stat-n">{graph.usedBy.length}</span>
        </div>
        <span className="deps-chips">{chips.join(' · ')}</span>
        <div className="flex-1" />
        {er?.enabled && (
          <button className="btn btn-xs" onClick={er.run} title={er.tooltip}>
            <Network size={13} /> Open in ER diagram
          </button>
        )}
        <button className="icon-btn sm" onClick={reload} title="Reload" aria-label="Reload dependencies">
          {loading ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {error && (
        <div className="deps-error" role="alert">
          <TriangleAlert size={13} /> {error}
        </div>
      )}
      {empty ? (
        <EmptyState
          icon={<Waypoints size={28} strokeWidth={1.5} />}
          title="No dependencies"
          hint={`Nothing references ${name}, and it references no other object${dialect === 'sqlite' ? ' (SQLite: views and triggers are scanned by name)' : ''}.`}
        />
      ) : (
        <div className="deps-columns">
          <DepColumn
            title="Uses"
            subtitle={`What ${name} depends on`}
            direction="uses"
            items={graph.uses}
            emptyText={`${name} does not reference other objects.`}
            rootSchema={graph.root.schema}
            onOpen={open}
            onMenu={menu}
          />
          <DepColumn
            title="Used by"
            subtitle={`What depends on ${name}`}
            direction="used"
            items={graph.usedBy}
            emptyText={`Nothing references ${name}.`}
            rootSchema={graph.root.schema}
            onOpen={open}
            onMenu={menu}
          />
        </div>
      )}
    </div>
  );
}

interface ColumnProps {
  title: string;
  subtitle: string;
  direction: 'uses' | 'used';
  items: ObjectDependency[];
  emptyText: string;
  rootSchema: string | null;
  onOpen(d: ObjectDependency): void;
  onMenu(d: ObjectDependency, e: { clientX: number; clientY: number; preventDefault?: () => void }): void;
}

function DepColumn({ title, subtitle, direction, items, emptyText, rootSchema, onOpen, onMenu }: ColumnProps) {
  const groups = groupDependencies(items);
  return (
    <section className={`deps-col ${direction}`} aria-label={title}>
      <header className="deps-col-head">
        {direction === 'uses' ? <ArrowUpRight size={14} aria-hidden="true" /> : <ArrowDownLeft size={14} aria-hidden="true" />}
        <span className="deps-col-title">{title}</span>
        <span className="deps-col-count">{items.length}</span>
        <span className="deps-col-sub">{subtitle}</span>
      </header>
      {groups.length === 0 ? (
        <div className="deps-col-empty">{emptyText}</div>
      ) : (
        groups.map((g) => (
          <div key={g.category} className="deps-group" role="list" aria-label={g.label}>
            <div className="deps-group-label">
              {g.label}
              <span className="deps-group-count">{g.items.length}</span>
            </div>
            {g.items.map((d, i) => (
              <DepRow key={`${d.kind}|${d.object.schema}|${d.object.name}|${d.object.type}|${i}`} d={d} rootSchema={rootSchema} onOpen={onOpen} onMenu={onMenu} />
            ))}
          </div>
        ))
      )}
    </section>
  );
}

const BADGE_TONE: Record<DepCategory, string> = { fk: 'fk', table: 'table', view: 'view', routine: 'routine', trigger: 'trigger', other: 'other' };

function DepRow({ d, rootSchema, onOpen, onMenu }: { d: ObjectDependency; rootSchema: string | null; onOpen(d: ObjectDependency): void; onMenu: ColumnProps['onMenu'] }) {
  const cat = categoryOf(d);
  const fk = d.kind === 'fk' ? splitFkDetail(d.detail) : null;
  const otherSchema = !!d.object.schema && d.object.schema !== rootSchema;
  const byName = d.detail === 'referenced in body';
  const label = `${d.object.schema ? `${d.object.schema}.` : ''}${d.object.name}`;
  return (
    <button
      type="button"
      role="listitem"
      className="deps-row"
      onClick={() => onOpen(d)}
      onContextMenu={(e) => onMenu(d, e)}
      title={`Open ${OBJECT_TYPE_SINGULAR[d.object.type]} ${label}${d.detail ? `\n${d.detail}` : ''}`}
    >
      <span className={`deps-icon tone-${BADGE_TONE[cat]}`}>
        <ObjectIcon type={d.object.type} size={14} />
      </span>
      <span className="deps-main">
        <span className="deps-name">
          {otherSchema && <span className="deps-schema">{d.object.schema}.</span>}
          {d.object.name}
        </span>
        {fk ? (
          <span className="deps-detail mono">
            {fk.mapping}
            {fk.constraint && <span className="deps-constraint"> · {fk.constraint}</span>}
            {fk.note && <span className="deps-note"> · {fk.note}</span>}
          </span>
        ) : d.detail && !byName ? (
          <span className="deps-detail">{d.detail}</span>
        ) : null}
      </span>
      {byName && <span className="deps-tag" title="Found by name in the definition (the server does not track this dependency)">by name</span>}
      <span className={`deps-badge tone-${BADGE_TONE[cat]}`}>{badgeOf(d)}</span>
    </button>
  );
}
