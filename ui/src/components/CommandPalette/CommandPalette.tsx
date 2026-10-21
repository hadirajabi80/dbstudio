import { Command as CommandIcon, Database, LoaderCircle, Search, SquareChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { insertIntoActiveEditor, openObject, preloadCatalog, selectTop } from '../../app/actions';
import { isMac } from '../../commands/keys';
import { advertisedShortcuts, getCommand, hasCommand, isEnabled, listCommands, runCommand } from '../../commands/registry';
import type { ObjectTarget } from '../../commands/types';
import { useCommandsVersion } from '../../commands/useCommands';
import type { CatalogObjectType } from '../../api/types';
import type { FuzzyResult } from '../../lib/fuzzy';
import { useSourceModules } from '../../lib/sources';
import { isTabular, OBJECT_TYPE_SINGULAR, qualifiedName } from '../../lib/sql';
import { dbKey, useCatalog } from '../../store/catalog';
import { dialectOf, providerKind, useConnections } from '../../store/connections';
import { getActiveConsole } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import { ColumnIcon, ObjectIcon, ProviderIcon } from '../common/icons';
import { ColorDot } from '../common/ConnectionBadge';
import { useRestoreFocus } from '../common/focus';
import { useExplorer } from '../Explorer/explorerStore';
import { Kbd } from '../Shortcuts/Kbd';
import { commandIcon } from '../layout/commandMenu';
import { collectEntries, DIAGRAM_PREFIX, parseObjectQuery, searchObjects, type IndexEntry, type SourceEntryType } from './objectIndex';

const SOURCE_ENTRY_LABEL: Record<SourceEntryType, string> = { 'redis.key': 'Key', 'mongo.collection': 'Collection', 'kafka.topic': 'Topic' };
import { paletteMatch, rankPalette, type PaletteMatch } from './paletteScore';

const MRU_KEY = 'dbstudio.palette.mru.v1';

function loadMru(): string[] {
  try {
    return JSON.parse(localStorage.getItem(MRU_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}
function pushMru(id: string) {
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify([id, ...loadMru().filter((x) => x !== id)].slice(0, 12)));
  } catch {
    /* ignore */
  }
}

function Hl({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  const parts: { s: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.s += text[i];
    else parts.push({ s: text[i], hit });
  }
  return <>{parts.map((p, i) => (p.hit ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}</>;
}

interface CmdItem {
  kind: 'command';
  key: string;
  id: string;
  title: string;
  category: string;
  shortcut?: string;
  /** Advertised alternatives (Format SQL: Ctrl+Alt+L next to Shift+Alt+F). */
  altShortcuts?: string[];
  icon?: string;
  recent: boolean;
  match: FuzzyResult;
}
interface ObjItem {
  kind: 'object';
  key: string;
  entry: IndexEntry;
  match: FuzzyResult;
}
/** Go-to mode: a connection whose catalog is not loaded yet (its objects cannot be searched until it is). */
interface LoadItem {
  kind: 'load';
  key: string;
  connectionId: string;
  name: string;
  color: string | null;
  loading: boolean;
}
type Item = CmdItem | ObjItem | LoadItem;

function targetOf(e: IndexEntry): ObjectTarget {
  return { kind: 'object', connectionId: e.connectionId, database: e.database, ref: e.ref };
}

/** Run an object hit: Enter opens, Mod+Enter data, Shift+Enter inserts the name, Alt+Enter reveals in the explorer. */
export function runObjectHit(e: IndexEntry, how: 'open' | 'data' | 'insert' | 'reveal'): void {
  if (e.source) {
    // M2: Redis keys / Mongo collections / Kafka topics open through their source module.
    if (how === 'insert') {
      if (getActiveConsole()) insertIntoActiveEditor(e.name);
      else toast('info', 'Open a console to insert the name');
    } else e.source.open();
    return;
  }
  const t = targetOf(e);
  if (how === 'data') {
    if (!isTabular(e.ref.type)) return openObject(e.connectionId, e.database, e.ref, e.column);
    if (hasCommand('data.open') && runCommand('data.open', t)) return;
    selectTop(e.connectionId, e.database, e.ref, 1000);
  } else if (how === 'insert') {
    if (!getActiveConsole()) {
      toast('info', 'Open a console to insert the name');
      return;
    }
    const def = useCatalog.getState().dbs[dbKey(e.connectionId, e.database)]?.defaultSchema ?? null;
    const name = qualifiedName(e.ref, dialectOf(e.connectionId), { defaultSchema: def });
    insertIntoActiveEditor(e.column ? `${name}.${e.column}` : name);
    const active = getActiveConsole();
    if (active?.connectionId && active.connectionId !== e.connectionId) {
      const from = useConnections.getState().connections.find((c) => c.id === e.connectionId)?.name;
      const to = useConnections.getState().connections.find((c) => c.id === active.connectionId)?.name;
      toast('info', `Inserted ${e.ref.name} from ${from ?? 'another connection'}`, `This console runs on ${to ?? 'another connection'}.`);
    }
  } else if (how === 'reveal') {
    useUi.getState().showDock('explorer');
    useExplorer.getState().reveal(t);
  } else openObject(e.connectionId, e.database, e.ref, e.column);
}

/** Ctrl+Shift+P commands; Ctrl+P (or "@" in the command box) goes to any loaded object across connections. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const mode = useUi((s) => s.paletteMode);
  const initial = useUi((s) => s.paletteQuery);
  const close = useUi((s) => s.closePalette);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dbs = useCatalog((s) => s.dbs);
  const catalogConns = useCatalog((s) => s.conns);
  const connections = useConnections((s) => s.connections);
  const version = useCommandsVersion();
  const paletteRef = useRef<HTMLDivElement>(null);
  // Esc / choosing gives the focus back to where the palette was opened from (never to <body>).
  useRestoreFocus(open, paletteRef);

  useEffect(() => {
    if (open) {
      setQ(mode === 'objects' ? initial : initial ? `>${initial}` : '');
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, mode, initial]);

  // Objects mode unless the text starts with ">" (commands) — commands mode is entered with ">" prefix shown.
  const objectMode = mode === 'objects' ? !q.startsWith('>') : q.startsWith('@');
  const text = objectMode ? (q.startsWith('@') ? q.slice(1) : q) : q.startsWith('>') ? q.slice(1) : q;
  const parsed = parseObjectQuery(text);
  const sourceVersion = useSourceModules((s) => s.version);
  const groups = useMemo(
    () => (open && objectMode ? collectEntries(dbs, parsed.prefix === 'c') : []),
    // sourceVersion: source modules (lib/sources.ts) changed their palette entries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, objectMode, dbs, parsed.prefix, sourceVersion],
  );
  const connName = useMemo(() => new Map(connections.map((c) => [c.id, c])), [connections]);
  const loadedCount = useMemo(() => groups.reduce((n, g) => n + g.length, 0), [groups]);
  // Connections the go-to index cannot see yet: offered as "Load catalog of X" rows (logic-24 f).
  const unloaded = useMemo(() => {
    if (!open || !objectMode) return [];
    const loaded = new Set(Object.values(dbs).filter((d) => Object.keys(d.loaded).length > 0).map((d) => d.connectionId));
    return connections.filter((c) => !loaded.has(c.id) && providerKind(c.providerId) === 'relational');
  }, [open, objectMode, dbs, connections]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    if (objectMode) {
      const hits: Item[] = searchObjects(groups, text, 200).map((h) => ({
        kind: 'object', key: `${h.entry.connectionId}|${h.entry.database}|${h.entry.schema}|${h.entry.type}|${h.entry.name}`, entry: h.entry, match: h.match,
      }));
      const p = parsed.pattern.toLowerCase();
      // Unloaded connections come last; with a query, those whose name matches first among them.
      const loads = unloaded
        .map((c): LoadItem => ({ kind: 'load', key: `load|${c.id}`, connectionId: c.id, name: c.name, color: c.color, loading: catalogConns[c.id]?.status === 'loading' }))
        .sort((a, b) => Number(!!p && b.name.toLowerCase().includes(p)) - Number(!!p && a.name.toLowerCase().includes(p)) || a.name.localeCompare(b.name));
      return [...hits, ...loads];
    }
    const p = text.trim();
    const mru = loadMru();
    const hits: { item: CmdItem; match: PaletteMatch }[] = [];
    for (const c of listCommands()) {
      if (c.palette === false) continue;
      if (!isEnabled(c.id)) continue;
      // Word-start or contiguous matches only; title > keywords > category (design-20).
      const m = paletteMatch(p, c);
      if (!m) continue;
      const recent = mru.indexOf(c.id);
      const score = m.score + (recent >= 0 ? (p ? 30 : 1000 - recent) : 0);
      hits.push({
        item: {
          kind: 'command', key: c.id, id: c.id, title: c.title, category: c.category, shortcut: c.shortcut, altShortcuts: advertisedShortcuts(c).slice(1), icon: c.icon,
          recent: recent >= 0, match: { score, positions: m.positions },
        },
        match: { ...m, score },
      });
    }
    return rankPalette(hits, p)
      .map((h) => h.item)
      .sort((a, b) => b.match.score - a.match.score || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, objectMode, text, groups, version, unloaded, catalogConns]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.selected')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const choose = (i: number, e?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => {
    const it = items[i];
    if (!it) return;
    if (it.kind === 'load') {
      // Stay open: the connection's objects join the list as soon as its catalog arrives.
      if (!it.loading) void preloadCatalog(it.connectionId, null).catch((err) => toast('error', `Could not load the catalog of ${it.name}`, String(err)));
      inputRef.current?.focus();
      return;
    }
    close();
    if (it.kind === 'command') {
      pushMru(it.id);
      setTimeout(() => runCommand(it.id), 0);
    } else {
      const how = e?.altKey ? 'reveal' : e?.shiftKey ? 'insert' : e?.ctrlKey || e?.metaKey ? 'data' : 'open';
      // er: (M2-ER) Enter opens the diagram of the table and its FK neighbours.
      if (how === 'open' && parsed.prefix === DIAGRAM_PREFIX && !it.entry.source && hasCommand('er.openRelated') && runCommand('er.openRelated', targetOf(it.entry))) return;
      runObjectHit(it.entry, how);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 10)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 10)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel, e); }
  };

  const noCatalog = objectMode && loadedCount === 0 && unloaded.length === 0;
  const placeholder = objectMode
    ? 'Go to object…  t: tables · v: views · p: procedures · f: functions · c: columns · k: keys · coll: collections · er: ER diagram · > commands'
    : 'Type a command…  @ to go to an object';

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={paletteRef} className="palette" role="dialog" aria-modal="true" aria-label={objectMode ? 'Go to object' : 'Command palette'}>
        <div className="palette-input-row">
          {/* ⌘ means nothing on Windows: a prompt glyph there. */}
          {objectMode ? (
            <Search size={16} className="palette-input-icon" />
          ) : isMac() ? (
            <CommandIcon size={16} className="palette-input-icon" />
          ) : (
            <SquareChevronRight size={16} className="palette-input-icon" />
          )}
          <input
            ref={inputRef}
            className="palette-input"
            value={q}
            placeholder={placeholder}
            aria-label={objectMode ? 'Object name' : 'Command'}
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `palette-opt-${sel}` : undefined}
            role="combobox"
            aria-expanded="true"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
          />
          <span className="palette-mode-chip">{objectMode ? 'Objects' : 'Commands'}</span>
        </div>
        <div className="palette-list" id="palette-list" ref={listRef} role="listbox">
          {items.length === 0 && (
            <div className="palette-empty">
              {noCatalog
                ? 'No objects loaded yet. Expand a connection in the explorer (or open a console on it) to search its objects.'
                : objectMode
                  ? 'No matching objects in the loaded schemas'
                  : 'No matching commands'}
            </div>
          )}
          {items.map((it, i) =>
            it.kind === 'load' ? (
              <div
                key={it.key}
                id={`palette-opt-${i}`}
                role="option"
                aria-selected={i === sel}
                className={`palette-item palette-load${i === sel ? ' selected' : ''}`}
                onMouseMove={() => i !== sel && setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i, e);
                }}
                title={`Load the catalog of ${it.name} so that its objects can be searched`}
              >
                <span className="palette-icon">{it.loading ? <LoaderCircle size={16} className="spin" /> : <Database size={16} strokeWidth={1.5} />}</span>
                <span className="palette-label">{it.loading ? `Loading the catalog of ${it.name}…` : `Load catalog of ${it.name}`}</span>
                <span className="palette-detail">not searched yet</span>
                <span className="palette-conn">
                  <ColorDot color={it.color} size={7} />
                  {it.name}
                </span>
              </div>
            ) : it.kind === 'command' ? (
              <div
                key={it.key}
                id={`palette-opt-${i}`}
                role="option"
                aria-selected={i === sel}
                className={`palette-item${i === sel ? ' selected' : ''}`}
                onMouseMove={() => i !== sel && setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i, e);
                }}
              >
                <span className="palette-icon">{commandIcon(it.icon) ?? <span className="palette-icon-blank" />}</span>
                <span className="palette-label">
                  <span className="palette-category">{it.category}: </span>
                  <Hl text={it.title} positions={it.match.positions.filter((p) => p >= 0)} />
                </span>
                {it.recent && !text && <span className="palette-detail">recently used</span>}
                {it.shortcut && (
                  <span className="palette-keys">
                    <Kbd shortcut={it.shortcut} />
                    {it.altShortcuts?.map((k) => <Kbd key={k} shortcut={k} />)}
                  </span>
                )}
              </div>
            ) : (
              <ObjectRow key={it.key} it={it} i={i} sel={sel} setSel={setSel} choose={choose} connName={connName} />
            ),
          )}
        </div>
        <div className="palette-footer" aria-hidden="true">
          {objectMode ? (
            <>
              <span><Kbd shortcut="Enter" /> open</span>
              <span><Kbd shortcut="Mod+Enter" /> {hasCommand('data.open') ? 'data' : 'select top 1000'}</span>
              <span><Kbd shortcut="Shift+Enter" /> insert name</span>
              <span><Kbd shortcut="Alt+Enter" /> reveal</span>
              <span className="flex-1" />
              <span className="muted">{loadedCount.toLocaleString()} objects indexed</span>
            </>
          ) : (
            <>
              <span><Kbd shortcut="Enter" /> run</span>
              <span><Kbd shortcut="ArrowUp" /><Kbd shortcut="ArrowDown" /> select</span>
              <span className="flex-1" />
              <span>{getCommand('view.shortcuts') ? <>All shortcuts <Kbd shortcut={getCommand('view.shortcuts')!.shortcut} /></> : null}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ObjectRow({ it, i, sel, setSel, choose, connName }: {
  it: ObjItem; i: number; sel: number; setSel: (n: number) => void;
  choose: (i: number, e?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }) => void;
  connName: Map<string, { name: string; color: string | null; providerId: string }>;
}) {
  const e = it.entry;
  const conn = connName.get(e.connectionId);
  const where = [e.schema, e.database && e.database !== e.schema ? e.database : null].filter(Boolean).join(' · ');
  return (
    <div
      id={`palette-opt-${i}`}
      role="option"
      aria-selected={i === sel}
      className={`palette-item${i === sel ? ' selected' : ''}`}
      onMouseMove={() => i !== sel && setSel(i)}
      onMouseDown={(ev) => {
        ev.preventDefault();
        choose(i, ev);
      }}
      title={`${e.source ? SOURCE_ENTRY_LABEL[e.source.type] : e.type === 'column' ? 'Column' : OBJECT_TYPE_SINGULAR[e.type as CatalogObjectType]} ${e.name} — ${conn?.name ?? ''}`}
    >
      <span className="palette-icon">
        {e.source ? <ProviderIcon providerId={conn?.providerId ?? ''} color={null} size={16} /> : e.type === 'column' ? <ColumnIcon /> : <ObjectIcon type={e.type as CatalogObjectType} />}
      </span>
      <span className="palette-label">
        <Hl text={e.name} positions={it.match.positions} />
      </span>
      <span className="palette-detail">{where}</span>
      <span className="palette-conn">
        <ColorDot color={conn?.color} size={7} />
        {conn?.name ?? ''}
      </span>
    </div>
  );
}
