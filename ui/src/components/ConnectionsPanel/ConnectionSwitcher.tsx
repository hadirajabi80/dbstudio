import { Database, Lock, Plus, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectionProfile } from '../../api/types';
import { effectiveDatabase, switchConnection, switchDatabase } from '../../app/actions';
import { fuzzyMatch } from '../../lib/fuzzy';
import { dbKey, useCatalog } from '../../store/catalog';
import { providerKind, schemaIsDatabase, schemaLevelLabel, useConnections } from '../../store/connections';
import { useTabSession } from '../../store/sessions';
import { useTabs } from '../../store/tabs';
import { useUi } from '../../store/ui';
import { ColorDot } from '../common/ConnectionBadge';
import { useRestoreFocus } from '../common/focus';
import { ProviderLogo } from '../../theme/brand/ProviderLogo';
import { Kbd } from '../Shortcuts/Kbd';

interface Row {
  key: string;
  label: string;
  detail?: string;
  group: string;
  conn?: ConnectionProfile;
  current: boolean;
  positions: number[];
  run: () => void;
}

/** MRU-first, folder-grouped connection list with fuzzy search; database/schema mode for Ctrl+Shift+D. */
export function ConnectionSwitcher() {
  const sw = useUi((s) => s.switcher);
  if (!sw) return null;
  return <Switcher key={`${sw.tabId}:${sw.mode}`} />;
}

function Switcher() {
  const sw = useUi((s) => s.switcher)!;
  const close = () => useUi.getState().openSwitcher(null);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === sw.tabId));
  const connections = useConnections((s) => s.connections);
  const session = useTabSession(sw.tabId);
  const conn = connections.find((c) => c.id === tab?.connectionId);
  const connCat = useCatalog((s) => (conn ? s.conns[conn.id] : undefined));
  // Oracle and the Batch 3 single-level providers switch schemas (MySQL/ClickHouse databases, Cassandra keyspaces).
  const singleLevel = schemaIsDatabase(conn?.providerId);
  const levelLabel = schemaLevelLabel(conn?.providerId);
  const oracleSchemas = useCatalog((s) => (conn && singleLevel ? s.dbs[dbKey(conn.id, null)]?.schemasResp : undefined));
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  // Esc / choosing gives the focus back to the editor (or the pill) the switcher was opened from.
  useRestoreFocus(true, boxRef);

  useEffect(() => {
    inputRef.current?.focus();
    if (sw.mode === 'database' && conn) {
      if (schemaIsDatabase(conn.providerId)) void useCatalog.getState().loadSchemas(conn.id, null);
      else void useCatalog.getState().loadDatabases(conn.id);
    }
  }, [sw.mode, conn]);

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const w = el.offsetWidth || 420;
    const a = sw.anchor;
    const left = a ? Math.min(Math.max(8, a.left), window.innerWidth - w - 8) : Math.max(8, (window.innerWidth - w) / 2);
    const top = a ? a.bottom + 4 : 64;
    setPos({ left, top });
  }, [sw.anchor]);

  const rows = useMemo<Row[]>(() => {
    if (!tab || tab.kind !== 'console') return [];
    const p = q.trim();
    if (sw.mode === 'database') {
      if (!conn) return [];
      let list: string[] = [];
      let current: string | null = null;
      if (singleLevel) {
        list = (oracleSchemas?.schemas ?? []).map((s) => s.name);
        current = tab.database ?? session?.database ?? oracleSchemas?.defaultSchema ?? null;
      } else {
        list = connCat?.databases?.databases ?? [];
        current = effectiveDatabase(conn.id, tab.database) ?? session?.database ?? null;
      }
      const out: Row[] = [];
      for (const d of list) {
        const m = fuzzyMatch(p, d);
        if (!m) continue;
        out.push({ key: d, label: d, group: levelLabel === 'schema' ? 'Schemas' : levelLabel === 'keyspace' ? 'Keyspaces' : 'Databases', current: d === current, positions: m.positions, run: () => void switchDatabase(tab.id, d) });
      }
      if (p) out.sort((a, b) => (fuzzyMatch(p, b.label)?.score ?? 0) - (fuzzyMatch(p, a.label)?.score ?? 0));
      return out;
    }
    const scored: (Row & { score: number })[] = [];
    const byRecent = [...connections].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''));
    const recentIds = new Set(byRecent.filter((c) => c.lastUsedAt).slice(0, 4).map((c) => c.id));
    for (const c of connections) {
      // M2: consoles run SQL; Redis/MongoDB/Kafka connections are not offered.
      if (providerKind(c.providerId) !== 'relational') continue;
      const m = fuzzyMatch(p, `${c.name} ${c.folder ?? ''}`);
      if (!m) continue;
      const group = !p && recentIds.has(c.id) ? 'Recent' : c.folder || 'Connections';
      scored.push({
        key: c.id, label: c.name, detail: c.folder ?? undefined, group, conn: c, current: c.id === tab.connectionId,
        positions: m.positions.filter((i) => i < c.name.length), score: m.score, run: () => void switchConnection(tab.id, c.id),
      });
    }
    if (p) scored.sort((a, b) => b.score - a.score);
    else {
      const order = (g: string) => (g === 'Recent' ? 0 : g === 'Connections' ? 2 : 1);
      scored.sort((a, b) => order(a.group) - order(b.group) || a.group.localeCompare(b.group)
        || (a.group === 'Recent' ? (b.conn!.lastUsedAt ?? '').localeCompare(a.conn!.lastUsedAt ?? '') : a.label.localeCompare(b.label)));
    }
    const out: Row[] = scored;
    out.push({ key: '__new', label: 'New connection…', group: '', current: false, positions: [], run: () => useUi.getState().openConnectionDialog({ mode: 'new', connectAfter: false }) });
    return out;
  }, [q, sw.mode, tab, conn, connections, connCat, oracleSchemas, session, singleLevel, levelLabel]);

  useEffect(() => {
    const i = rows.findIndex((r) => r.current);
    setSel(q ? 0 : Math.max(0, i));
  }, [q, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    boxRef.current?.querySelector('.switcher-item.selected')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel]);

  const choose = (i: number) => {
    const r = rows[i];
    if (!r) return;
    close();
    r.run();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(rows.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  };

  let lastGroup: string | null = null;
  return (
    <div className="overlay transparent" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={boxRef}
        className="switcher"
        role="dialog"
        aria-modal="true"
        aria-label={sw.mode === 'database' ? 'Change database' : 'Change connection'}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onKeyDown}
      >
        <div className="switcher-search">
          <Search size={14} />
          <input
            ref={inputRef}
            className="input borderless"
            placeholder={sw.mode === 'database' ? `Switch ${levelLabel}…` : 'Switch connection…'}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="switcher-list"
            spellCheck={false}
          />
          <Kbd shortcut={sw.mode === 'database' ? 'Mod+Shift+D' : 'Mod+Shift+K'} />
        </div>
        <div className="switcher-list" id="switcher-list" role="listbox">
          {rows.length === 0 && <div className="switcher-empty">{sw.mode === 'database' ? 'Loading…' : 'No matching connections'}</div>}
          {rows.map((r, i) => {
            const header = r.group !== lastGroup && r.group ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={r.key}>
                {header && <div className="switcher-group">{header}</div>}
                {r.key === '__new' && <div className="menu-sep" />}
                <div
                  role="option"
                  aria-selected={i === sel}
                  className={`switcher-item${i === sel ? ' selected' : ''}${r.current ? ' current' : ''}`}
                  onMouseMove={() => i !== sel && setSel(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(i);
                  }}
                >
                  {r.conn ? <ProviderLogo providerId={r.conn.providerId} size={16} /> : r.key === '__new' ? <Plus size={16} /> : <Database size={16} strokeWidth={1.5} />}
                  {r.conn && <ColorDot color={r.conn.color} size={8} />}
                  <span className="switcher-label">
                    {highlight(r.label, r.positions)}
                  </span>
                  {r.conn?.readOnly && <Lock size={12} aria-label="Read-only" />}
                  {r.detail && r.group !== r.detail && <span className="switcher-detail">{r.detail}</span>}
                  {r.current && <span className="switcher-current">current</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function highlight(text: string, positions: number[]) {
  if (!positions.length) return text;
  const set = new Set(positions);
  return [...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : <span key={i}>{ch}</span>));
}
