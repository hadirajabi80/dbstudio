import { Layers, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ConnectionProfile, RunLabel } from '../../api/types';
import { getEditor } from '../../app/editors';
import { runMulti, type MultiTarget } from '../../app/multiRun';
import { useCatalog } from '../../store/catalog';
import { hasDatabaseLevel, providerKind, useConnections } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { toast, useUi } from '../../store/ui';
import { ColorDot } from '../common/ConnectionBadge';
import { Dialog } from '../common/Dialog';
import { ProviderIcon } from '../common/icons';
import { Select } from '../common/Select';
import { Kbd } from '../Shortcuts/Kbd';

const LAST_KEY = 'dbstudio.multirun.last.v1';

function loadLast(): MultiTarget[] {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? '[]') as MultiTarget[];
  } catch {
    return [];
  }
}

/** Ctrl+Alt+Enter: choose the connections (and optional database per connection) to run the statement/script on. */
export function MultiRunDialog() {
  const tabId = useUi((s) => s.multiRunFor);
  if (!tabId) return null;
  return <Inner key={tabId} tabId={tabId} />;
}

function Inner({ tabId }: { tabId: string }) {
  const close = () => useUi.getState().openMultiRun(null);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === tabId));
  const allConnections = useConnections((s) => s.connections);
  // M2: multi-run executes SQL, so only relational connections are listed.
  const connections = useMemo(() => allConnections.filter((c) => providerKind(c.providerId) === 'relational'), [allConnections]);
  const catConns = useCatalog((s) => s.conns);
  const [what, setWhat] = useState<RunLabel>('statement');
  const [picked, setPicked] = useState<Map<string, string | null>>(() => {
    const m = new Map<string, string | null>();
    const last = loadLast().filter((t) => connections.some((c) => c.id === t.connectionId));
    for (const t of last) m.set(t.connectionId, t.database);
    if (tab?.connectionId && !m.has(tab.connectionId)) m.set(tab.connectionId, tab.kind === 'console' ? tab.database : null);
    return m;
  });

  useEffect(() => {
    for (const c of connections) if (hasDatabaseLevel(c.providerId) && picked.has(c.id)) void useCatalog.getState().loadDatabases(c.id);
  }, [connections, picked]);

  const folders = useMemo(() => {
    const m = new Map<string, ConnectionProfile[]>();
    for (const c of [...connections].sort((a, b) => a.name.localeCompare(b.name))) {
      const f = c.folder ?? '';
      if (!m.has(f)) m.set(f, []);
      m.get(f)!.push(c);
    }
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  }, [connections]);

  const toggle = (id: string, on: boolean) => {
    const next = new Map(picked);
    if (on) next.set(id, next.get(id) ?? null);
    else next.delete(id);
    setPicked(next);
  };

  const run = () => {
    if (!tab || tab.kind !== 'console') return;
    const target = getEditor(tabId)?.getRunTarget(what);
    if (!target || !target.batches.some((b) => b.sql.trim())) {
      toast('info', 'Nothing to run', 'Place the cursor in a statement or select some SQL.');
      return;
    }
    const targets: MultiTarget[] = connections.filter((c) => picked.has(c.id)).map((c) => ({ connectionId: c.id, database: picked.get(c.id) ?? null }));
    if (!targets.length) return;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(targets));
    } catch {
      /* ignore */
    }
    close();
    void runMulti({ sourceTabId: tabId, title: tab.title, label: what, batches: target.batches, targets });
  };

  const count = picked.size;
  return (
    <Dialog
      title={<span className="dialog-title-icon"><Layers size={16} /> Run on multiple connections</span>}
      ariaLabel="Run on multiple connections"
      onClose={close}
      width={560}
      className="multirun-dialog"
      footer={
        <>
          <span className="muted">Runs concurrently; each connection gets its own session and history entry.</span>
          <div className="flex-1" />
          <button className="btn" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={run} disabled={count === 0}>
            <Play size={13} fill="currentColor" /> Run on {count || '…'} <Kbd shortcut="Mod+Enter" className="on-accent" />
          </button>
        </>
      }
    >
      <div
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            run();
          }
        }}
      >
        <div className="segmented wide" role="radiogroup" aria-label="What to run">
          {(['statement', 'script'] as RunLabel[]).map((w) => (
            <button key={w} role="radio" aria-checked={what === w} className={what === w ? 'on' : ''} onClick={() => setWhat(w)}>
              {w === 'statement' ? 'Statement at cursor / selection' : 'Whole script (or selection)'}
            </button>
          ))}
        </div>
        <div className="multirun-targets" role="group" aria-label="Connections">
          {folders.map(([folder, list]) => {
            const all = list.every((c) => picked.has(c.id));
            const some = list.some((c) => picked.has(c.id));
            return (
              <div key={folder || '__none'} className="multirun-folder">
                {folder && (
                  <label className="check multirun-folder-label">
                    <input
                      type="checkbox"
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = some && !all;
                      }}
                      onChange={(e) => {
                        const next = new Map(picked);
                        for (const c of list) {
                          if (e.target.checked) next.set(c.id, next.get(c.id) ?? null);
                          else next.delete(c.id);
                        }
                        setPicked(next);
                      }}
                    />
                    All in {folder}
                  </label>
                )}
                {list.map((c) => {
                  const dbs = catConns[c.id]?.databases?.databases ?? [];
                  return (
                    <div key={c.id} className={`multirun-row${folder ? ' nested' : ''}`}>
                      <label className="check">
                        <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                        <ProviderIcon providerId={c.providerId} color={null} size={16} />
                        <ColorDot color={c.color} size={8} />
                        <span>{c.name}</span>
                        {c.id === tab?.connectionId && <span className="pill pill-muted">this console</span>}
                      </label>
                      {hasDatabaseLevel(c.providerId) && picked.has(c.id) && (
                        <Select
                          size="sm"
                          aria-label={`Database for ${c.name}`}
                          value={picked.get(c.id) ?? ''}
                          options={[{ value: '', label: 'Default database' }, ...dbs.map((d) => ({ value: d, label: d }))]}
                          onChange={(v) => setPicked(new Map(picked).set(c.id, v || null))}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </Dialog>
  );
}
