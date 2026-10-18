import { create } from 'zustand';
import { api, isApiError } from '../api/client';
import type { SessionInfo, TxMode, WsEventOf } from '../api/types';

/**
 * Engine sessions, keyed by sessionId; each editor tab owns at most one (created lazily on first run,
 * closed with the tab or when the tab switches connection). Several connections can be in use at once.
 */
interface SessionsState {
  sessions: Record<string, SessionInfo>;
  byTab: Record<string, string>;
  /** Ensure the tab has a session on this connection/database; replaces a session on another connection. */
  ensure(tabId: string, connectionId: string, database: string | null, txMode: TxMode): Promise<SessionInfo>;
  forTab(tabId: string): SessionInfo | undefined;
  setTxMode(tabId: string, mode: TxMode): Promise<SessionInfo | undefined>;
  commit(tabId: string): Promise<void>;
  rollback(tabId: string): Promise<void>;
  changeDatabase(tabId: string, database: string): Promise<void>;
  close(tabId: string, force?: boolean): Promise<void>;
  applyChanged(ev: WsEventOf<'session.changed'>): void;
  applyDone(ev: WsEventOf<'exec.done'>): void;
  upsert(info: SessionInfo, tabId?: string): void;
  /** GET /sessions: refresh every known session (state, executingSince); drops sessions the engine forgot. */
  refreshAll(): Promise<void>;
  /** Close one session by id (active-connections panel). */
  closeSession(sessionId: string, force?: boolean): Promise<void>;
  /** Close every session of a connection (explorer "Disconnect"). Returns the number closed. */
  closeConnection(connectionId: string, force?: boolean): Promise<number>;
  /** Tab that owns a session, if any. */
  tabOf(sessionId: string): string | undefined;
  /**
   * Re-attach engine sessions to open tabs after a reload/reconnect: `resolveTab` maps a session (its `tabId` is the
   * `source.tabId` of its last run) to the tab key that should own it, or null. Returns the adopted session ids.
   * A tab that already owns a live session keeps it.
   */
  adopt(resolveTab: (s: SessionInfo) => string | null): string[];
  /**
   * Engine sessions no open tab owns and that are free to take over or release: the engine reports their window gone
   * (`orphan`), or this window opened them before a reload. Optionally of one connection.
   */
  orphans(connectionId?: string): SessionInfo[];
  /** Sessions another live window is using (the engine says `orphan: false` and this window never owned them). */
  foreign(connectionId?: string): SessionInfo[];
  /** Debounced refreshAll (session.changed events, reconnects). */
  refreshSoon(delayMs?: number): void;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

const creating = new Map<string, Promise<SessionInfo>>();

// ---------- ownership (logic-r1-03) ----------
// The engine marks a session `orphan` when the window that owns it has no live WebSocket. A page reload keeps this
// window's client id (sessionStorage, api/clientId.ts), so once the socket is back its own sessions read `orphan:
// false` like those of another live window. The ids this window's tabs held are therefore kept in sessionStorage too
// (per browser tab, survives a reload): those are ours to adopt or release; any other non-orphan is someone else's.

const OWN_KEY = 'dbstudio.ownSessions';

function loadOwn(): Set<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(OWN_KEY);
    const ids = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

const own = loadOwn();

function saveOwn(): void {
  try {
    globalThis.sessionStorage?.setItem(OWN_KEY, JSON.stringify([...own]));
  } catch {
    // storage blocked: ownership lasts for this page load
  }
}

function markOwn(sessionId: string): void {
  if (own.has(sessionId)) return;
  own.add(sessionId);
  saveOwn();
}

function forgetOwn(ids: Iterable<string>): void {
  let changed = false;
  for (const id of ids) changed = own.delete(id) || changed;
  if (changed) saveOwn();
}

/**
 * True when another live window uses the session: the engine reports its owner connected (`orphan === false`) and this
 * window never owned it. Such a session is listed read-only, never adopted, closed or released from here. An engine
 * that does not report `orphan` (field absent) keeps the old single-window behaviour.
 */
export function isForeignSession(s: SessionInfo): boolean {
  return s.orphan === false && !own.has(s.sessionId);
}

/** Tests: reset the remembered ownership. */
export function resetOwnSessionsForTests(ids: string[] = []): void {
  own.clear();
  for (const id of ids) own.add(id);
  saveOwn();
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: {},
  byTab: {},

  upsert(info, tabId) {
    const s = get();
    if (tabId) markOwn(info.sessionId);
    set({
      sessions: { ...s.sessions, [info.sessionId]: info },
      byTab: tabId ? { ...s.byTab, [tabId]: info.sessionId } : s.byTab,
    });
  },

  forTab(tabId) {
    const sid = get().byTab[tabId];
    return sid ? get().sessions[sid] : undefined;
  },

  async ensure(tabId, connectionId, database, txMode) {
    const existing = get().forTab(tabId);
    if (existing && existing.connectionId === connectionId && existing.state !== 'closed') {
      if (database && existing.database !== database) {
        try {
          const info = await api.changeDatabase(existing.sessionId, database);
          get().upsert(info, tabId);
          return info;
        } catch (e) {
          if (!isApiError(e, 'NOT_SUPPORTED')) throw e;
        }
      }
      return existing;
    }
    const pending = creating.get(tabId);
    if (pending) return pending;
    const p = (async () => {
      if (existing) await get().close(tabId, true);
      const info = await api.createSession({ connectionId, database, txMode, captureServerOutput: true });
      get().upsert(info, tabId);
      return info;
    })().finally(() => creating.delete(tabId));
    creating.set(tabId, p);
    return p;
  },

  async setTxMode(tabId, mode) {
    const s = get().forTab(tabId);
    if (!s) return undefined;
    const info = await api.setTxMode(s.sessionId, mode);
    get().upsert(info, tabId);
    return info;
  },

  async commit(tabId) {
    const s = get().forTab(tabId);
    if (!s) return;
    get().upsert(await api.commit(s.sessionId), tabId);
  },

  async rollback(tabId) {
    const s = get().forTab(tabId);
    if (!s) return;
    get().upsert(await api.rollback(s.sessionId), tabId);
  },

  async changeDatabase(tabId, database) {
    const s = get().forTab(tabId);
    if (!s) return;
    get().upsert(await api.changeDatabase(s.sessionId, database), tabId);
  },

  async close(tabId, force = false) {
    const sid = get().byTab[tabId];
    if (!sid) return;
    try {
      await api.closeSession(sid, force);
    } catch (e) {
      if (!isApiError(e, 'NOT_FOUND')) throw e;
    }
    const { sessions, byTab } = get();
    const nextSessions = { ...sessions };
    delete nextSessions[sid];
    const nextByTab = { ...byTab };
    delete nextByTab[tabId];
    forgetOwn([sid]);
    set({ sessions: nextSessions, byTab: nextByTab });
  },

  async refreshAll() {
    let list: SessionInfo[];
    try {
      list = await api.listSessions();
    } catch {
      return;
    }
    const known = new Map(list.map((x) => [x.sessionId, x]));
    const { sessions, byTab } = get();
    const nextSessions: Record<string, SessionInfo> = {};
    for (const [sid, cur] of Object.entries(sessions)) {
      const fresh = known.get(sid);
      if (fresh) nextSessions[sid] = { ...cur, ...fresh };
    }
    // Sessions opened elsewhere (another window, multi-run) are listed too, without a tab.
    for (const x of list) if (!nextSessions[x.sessionId]) nextSessions[x.sessionId] = x;
    const nextByTab: Record<string, string> = {};
    for (const [tab, sid] of Object.entries(byTab)) if (nextSessions[sid]) nextByTab[tab] = sid;
    forgetOwn([...own].filter((sid) => !known.has(sid)));
    set({ sessions: nextSessions, byTab: nextByTab });
  },

  async closeSession(sessionId, force = true) {
    try {
      await api.closeSession(sessionId, force);
    } catch (e) {
      if (!isApiError(e, 'NOT_FOUND')) throw e;
    }
    const { sessions, byTab } = get();
    const nextSessions = { ...sessions };
    delete nextSessions[sessionId];
    const nextByTab = Object.fromEntries(Object.entries(byTab).filter(([, sid]) => sid !== sessionId));
    forgetOwn([sessionId]);
    set({ sessions: nextSessions, byTab: nextByTab });
  },

  async closeConnection(connectionId, force = true) {
    // Sessions of another live window are left alone: disconnecting here must not roll back work over there.
    const ids = Object.values(get().sessions).filter((x) => x.connectionId === connectionId && !isForeignSession(x)).map((x) => x.sessionId);
    await Promise.all(ids.map((sid) => get().closeSession(sid, force).catch((e) => console.warn('[sessions] close failed', e))));
    return ids.length;
  },

  tabOf(sessionId) {
    return Object.entries(get().byTab).find(([, sid]) => sid === sessionId)?.[0];
  },

  adopt(resolveTab) {
    const { sessions, byTab } = get();
    const owned = new Set(Object.values(byTab));
    const next = { ...byTab };
    const adopted: string[] = [];
    // Most recently active first, so a tab with several leaked sessions adopts the one with an open transaction.
    const candidates = Object.values(sessions)
      .filter((s) => !owned.has(s.sessionId) && s.state !== 'closed' && !isForeignSession(s))
      .sort((a, b) => Number(b.txOpen) - Number(a.txOpen));
    for (const s of candidates) {
      const tab = resolveTab(s);
      if (!tab) continue;
      const cur = next[tab];
      if (cur && sessions[cur]) continue;
      next[tab] = s.sessionId;
      adopted.push(s.sessionId);
      markOwn(s.sessionId);
    }
    if (adopted.length) set({ byTab: next });
    return adopted;
  },

  orphans(connectionId) {
    const owned = new Set(Object.values(get().byTab));
    return Object.values(get().sessions).filter((s) => !owned.has(s.sessionId) && s.state !== 'closed' && !isForeignSession(s) && (!connectionId || s.connectionId === connectionId));
  },

  foreign(connectionId) {
    const owned = new Set(Object.values(get().byTab));
    return Object.values(get().sessions).filter((s) => !owned.has(s.sessionId) && s.state !== 'closed' && isForeignSession(s) && (!connectionId || s.connectionId === connectionId));
  },

  refreshSoon(delayMs = 250) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void get().refreshAll();
    }, delayMs);
  },

  applyChanged(ev) {
    const cur = get().sessions[ev.sessionId];
    if (!cur) return;
    set({
      sessions: {
        ...get().sessions,
        [ev.sessionId]: { ...cur, state: ev.state, txOpen: ev.txOpen, database: ev.database ?? cur.database, txMode: ev.txMode ?? cur.txMode },
      },
    });
  },

  applyDone(ev) {
    const cur = get().sessions[ev.sessionId];
    if (!cur) return;
    set({ sessions: { ...get().sessions, [ev.sessionId]: { ...cur, txOpen: ev.txOpen, state: cur.state === 'executing' ? 'idle' : cur.state } } });
  },
}));

/**
 * One definition of "connected" for the status bar, the dock badge and the explorer dot: the connection has an open
 * engine session, or its catalog is loaded (browsing the explorer opens a connection without a console session).
 */
export type ConnectionActivity = { kind: 'session'; sessions: number } | { kind: 'catalog' } | null;

export function connectionActivity(
  connectionId: string, sessions: Record<string, SessionInfo>, catalogStatus: (connectionId: string) => string | undefined,
): ConnectionActivity {
  let n = 0;
  for (const s of Object.values(sessions)) if (s.connectionId === connectionId && s.state !== 'closed') n++;
  if (n) return { kind: 'session', sessions: n };
  return catalogStatus(connectionId) === 'ready' ? { kind: 'catalog' } : null;
}

/** Engine-wide counts: connections that are connected (sessions or loaded catalog) and open sessions. */
export function activityCounts(sessions: Record<string, SessionInfo>, catalogConns: Record<string, { status: string }>): { connections: number; sessions: number } {
  const live = Object.values(sessions).filter((s) => s.state !== 'closed');
  const ids = new Set(live.map((s) => s.connectionId));
  for (const [cid, c] of Object.entries(catalogConns)) if (c.status === 'ready') ids.add(cid);
  return { connections: ids.size, sessions: live.length };
}

export function useTabSession(tabId: string | null | undefined): SessionInfo | undefined {
  return useSessions((s) => {
    if (!tabId) return undefined;
    const sid = s.byTab[tabId];
    return sid ? s.sessions[sid] : undefined;
  });
}
