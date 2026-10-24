// "Console settings" (cassandra.session): consistency, serial consistency, tracing, page size and insert TTL of one
// console's session (GET/PUT /cassandra/sessions/{sid}/settings), its keyspace and its last trace.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../../api/client';
import { engineSocket } from '../../api/ws';
import {
  CQL_CONSISTENCY_LEVELS, type CqlConsistency, type CqlSerialConsistency, type CqlSessionSettings, type CqlSessionSettingsPatch,
} from '../../api/types.cassandra';
import { getConnection } from '../../store/connections';
import { useSessions } from '../../store/sessions';
import { useTabs, type ConsoleTab } from '../../store/tabs';
import { Select } from '../common/Select';
import type { TabViewProps } from '../layout/tabViews';
import { consoleSessionId, isCassandraConnection, onSettingsChanged, openTrace, type SessionViewState } from './open';
import { Banner, Empty, RefreshButton, ViewHeader } from './parts';
import { useLoad } from './useLoad';

const LEVEL_HINT: Partial<Record<CqlConsistency, string>> = {
  ONE: 'one replica', TWO: 'two replicas', THREE: 'three replicas', QUORUM: 'majority of all replicas', ALL: 'every replica',
  LOCAL_ONE: 'one replica in the local DC', LOCAL_QUORUM: 'majority in the local DC', EACH_QUORUM: 'majority in every DC (writes)',
  ANY: 'any node, hints count (writes)', SERIAL: 'linearizable reads (Paxos)', LOCAL_SERIAL: 'linearizable reads in the local DC',
};
const LEVELS = CQL_CONSISTENCY_LEVELS.map((v) => ({ value: v, label: v, hint: LEVEL_HINT[v] }));
const SERIAL_LEVELS: { value: CqlSerialConsistency; label: string; hint: string }[] = [
  { value: 'SERIAL', label: 'SERIAL', hint: 'Paxos across all DCs' },
  { value: 'LOCAL_SERIAL', label: 'LOCAL_SERIAL', hint: 'Paxos in the local DC' },
];

const MAX_PAGE = 10_000;
const MAX_TTL = 630_720_000; // 20 years, Cassandra's limit

function parsePageSize(text: string): number | string {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 && n <= MAX_PAGE ? n : `Page size must be a whole number between 1 and ${MAX_PAGE}.`;
}

function parseTtl(text: string): number | null | string {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= MAX_TTL ? n : `Insert TTL must be empty or a whole number of seconds between 0 and ${MAX_TTL}.`;
}

export function SessionView({ tab }: TabViewProps) {
  const st = (tab.state ?? { consoleTabId: null }) as SessionViewState;
  const consoleTab = useTabs((s) => s.tabs.find((t) => t.id === st.consoleTabId && t.kind === 'console')) as ConsoleTab | undefined;
  const session = useSessions((s) => {
    const id = st.consoleTabId ? s.byTab[st.consoleTabId] : undefined;
    return id ? s.sessions[id] : undefined;
  });
  const sid = (session && session.state !== 'closed' && session.connectionId === consoleTab?.connectionId ? session.sessionId : null)
    ?? (st.consoleTabId ? null : st.sessionId ?? null);
  const cid = consoleTab?.connectionId ?? tab.connectionId;
  const cassandra = isCassandraConnection(cid);
  const [connectError, setConnectError] = useState<string | null>(null);

  // A console that has not run anything yet has no session: open it like the console's first run would.
  useEffect(() => {
    if (sid || !consoleTab || !cassandra) return;
    let live = true;
    consoleSessionId(consoleTab).catch((e: unknown) => live && setConnectError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [sid, consoleTab, cassandra]);

  const loaded = useLoad(sid, () => api.cassandra.sessionSettings(sid!));
  const { reload } = loaded;
  // the answer of the last PUT (optimistic first) until the next load
  const [saved, setSaved] = useState<{ base: CqlSessionSettings; value: CqlSessionSettings } | null>(null);
  const settings = saved && saved.base === loaded.data ? saved.value : loaded.data;

  // Shell commands run in the console (CONSISTENCY ONE, TRACING ON, PAGING 50 …) change the same settings.
  useEffect(() => {
    if (!sid) return;
    const offExec = engineSocket.on('exec.done', (ev) => {
      if (ev.sessionId === sid) reload();
    });
    const offCmd = onSettingsChanged(sid, reload);
    return () => {
      offExec();
      offCmd();
    };
  }, [sid, reload]);

  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = async (p: CqlSessionSettingsPatch) => {
    const base = loaded.data;
    if (!sid || !settings || !base) return;
    setSaveError(null);
    setSaving(true);
    setSaved({ base, value: { ...settings, ...p } });
    try {
      const value = await api.cassandra.setSessionSettings(sid, p);
      setSaved({ base, value });
    } catch (e) {
      setSaveError(errorMessage(e));
      setSaved(null);
      reload();
    } finally {
      setSaving(false);
    }
  };

  // "Set consistency level…": open the level list once the settings are there
  const levelRef = useRef<HTMLButtonElement>(null);
  const tabId = tab.id;
  const focusLevel = st.focus === 'consistency' && settings !== null;
  useEffect(() => {
    if (!focusLevel) return;
    levelRef.current?.focus();
    levelRef.current?.click();
    const t = useTabs.getState().tabs.find((x) => x.id === tabId);
    if (t?.kind === 'view') useTabs.getState().updateView(tabId, { state: { ...(t.state as SessionViewState), focus: null } });
  }, [focusLevel, tabId]);

  const title = consoleTab ? `Console settings: ${consoleTab.title}` : 'Console settings';
  const subtitle = cid ? getConnection(cid)?.name : undefined;
  if (st.consoleTabId && !consoleTab) {
    return (
      <div className="cs-view" data-testid="cassandra-session">
        <ViewHeader title={title} />
        <Empty>The console of these settings was closed.</Empty>
      </div>
    );
  }
  if (!cassandra) {
    return (
      <div className="cs-view" data-testid="cassandra-session">
        <ViewHeader title={title} subtitle={subtitle} />
        <Empty>This console is not connected to a Cassandra cluster.</Empty>
      </div>
    );
  }
  return (
    <div className="cs-view" data-testid="cassandra-session">
      <ViewHeader title={title} subtitle={subtitle}>
        <RefreshButton onClick={reload} busy={loaded.loading} />
      </ViewHeader>
      {connectError && !sid && <Banner>{connectError}</Banner>}
      {loaded.error && <Banner actions={<button type="button" className="btn btn-xs" onClick={reload}>Retry</button>}>{loaded.error}</Banner>}
      {saveError && <Banner>{saveError}</Banner>}
      {!settings && !loaded.error && !(connectError && !sid) && <Empty>{sid ? 'Loading settings…' : 'Opening the console session…'}</Empty>}
      {settings && sid && (
        <div className="cs-scroll">
          <section className="cs-section" aria-labelledby={`${tab.id}-req`}>
            <h3 className="cs-section-title" id={`${tab.id}-req`}>Requests</h3>
            <p className="cs-section-help">Apply to every following statement of this console, like the cqlsh shell commands.</p>
            <div className="cs-form">
              <label className="cs-label" htmlFor={`${tab.id}-cl`}>Consistency</label>
              <div className="cs-control">
                <Select
                  id={`${tab.id}-cl`} className="cs-primary cs-select" value={settings.consistency} options={LEVELS} triggerRef={levelRef} mono
                  onChange={(v) => void patch({ consistency: v })} disabled={saving}
                />
                <code className="cs-cqlsh">CONSISTENCY {settings.consistency}</code>
              </div>
              <label className="cs-label" htmlFor={`${tab.id}-scl`}>Serial consistency</label>
              <div className="cs-control">
                <Select
                  id={`${tab.id}-scl`} className="cs-select" value={settings.serialConsistency} options={SERIAL_LEVELS} mono
                  onChange={(v) => void patch({ serialConsistency: v })} disabled={saving}
                />
                <span className="cs-help">Paxos phase of lightweight transactions (<code>IF …</code>).</span>
              </div>
              <span className="cs-label" id={`${tab.id}-tr`}>Tracing</span>
              <div className="cs-control">
                <label className="check">
                  <input type="checkbox" aria-labelledby={`${tab.id}-tr`} checked={settings.tracing} disabled={saving} onChange={(e) => void patch({ tracing: e.target.checked })} />
                  {' '}Trace every statement
                </label>
                <code className="cs-cqlsh">TRACING {settings.tracing ? 'ON' : 'OFF'}</code>
              </div>
              <NumberField
                id={`${tab.id}-ps`} label="Page size" value={settings.pageSize} parse={parsePageSize} disabled={saving}
                help="Rows per round trip." cqlsh={`PAGING ${settings.pageSize}`} onCommit={(v) => void patch({ pageSize: v as number })}
              />
              <NumberField
                id={`${tab.id}-ttl`} label="Insert TTL (s)" value={settings.insertTtl} parse={parseTtl} disabled={saving} placeholder="none"
                help="Added to rows inserted in the data grid (USING TTL n); empty for none." onCommit={(v) => void patch({ insertTtl: v as number | null })}
              />
            </div>
          </section>
          <section className="cs-section" aria-labelledby={`${tab.id}-ses`}>
            <h3 className="cs-section-title" id={`${tab.id}-ses`}>Session</h3>
            <dl className="cs-dl">
              <dt>Keyspace</dt>
              <dd>{settings.keyspace ? <code>{settings.keyspace}</code> : <span className="muted">none (USE keyspace)</span>}
                <span className="cs-help">Change it with <code>USE</code> or the keyspace switcher of the console.</span>
              </dd>
              <dt>Session id</dt>
              <dd><code className="mono">{sid}</code></dd>
              <dt>Last trace</dt>
              <dd>
                {settings.lastTraceId ? <code className="mono">{settings.lastTraceId}</code> : <span className="muted">none yet{settings.tracing ? '' : ' (turn tracing on)'}</span>}
                <span className="cs-inline-actions">
                  {settings.lastTraceId && cid && (
                    <button type="button" className="btn btn-xs" onClick={() => openTrace(cid, settings.lastTraceId, { consoleTabId: consoleTab?.id ?? null, sessionId: sid })}>Open trace</button>
                  )}
                  {cid && (
                    <button type="button" className="btn btn-xs" onClick={() => openTrace(cid, null, { consoleTabId: consoleTab?.id ?? null, sessionId: sid })}>All traces</button>
                  )}
                </span>
              </dd>
            </dl>
          </section>
        </div>
      )}
    </div>
  );
}

function NumberField<T extends number | null>({ id, label, value, parse, onCommit, help, cqlsh, placeholder, disabled }: {
  id: string; label: string; value: T; parse(text: string): T | string; onCommit(v: T): void; help: string; cqlsh?: string; placeholder?: string; disabled?: boolean;
}) {
  // the user's text while editing; a new value from the engine (or a shell command) replaces it
  const [edit, setEdit] = useState<{ base: T; text: string; problem: string | null } | null>(null);
  const current = edit && edit.base === value ? edit : null;
  const text = current ? current.text : value === null ? '' : String(value);
  const problem = current?.problem ?? null;
  const commit = () => {
    const v = parse(text);
    if (typeof v === 'string') {
      setEdit({ base: value, text, problem: v });
      return;
    }
    setEdit(null);
    if (v !== value) onCommit(v);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') setEdit(null);
  };
  return (
    <>
      <label className="cs-label" htmlFor={id}>{label}</label>
      <div className="cs-control">
        <input
          id={id} className="input cs-num" inputMode="numeric" value={text} placeholder={placeholder} disabled={disabled}
          aria-invalid={problem ? true : undefined} aria-describedby={`${id}-help`}
          onChange={(e) => setEdit({ base: value, text: e.target.value, problem: null })} onBlur={commit} onKeyDown={onKey}
        />
        {cqlsh && <code className="cs-cqlsh">{cqlsh}</code>}
        <span className={`cs-help${problem ? ' cs-help-error' : ''}`} id={`${id}-help`} role={problem ? 'alert' : undefined}>{problem ?? help}</span>
      </div>
    </>
  );
}
