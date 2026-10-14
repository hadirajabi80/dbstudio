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
}

const creating = new Map<string, Promise<SessionInfo>>();

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: {},
  byTab: {},

  upsert(info, tabId) {
    const s = get();
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
    set({ sessions: nextSessions, byTab: nextByTab });
  },

  async closeConnection(connectionId, force = true) {
    const ids = Object.values(get().sessions).filter((x) => x.connectionId === connectionId).map((x) => x.sessionId);
    await Promise.all(ids.map((sid) => get().closeSession(sid, force).catch((e) => console.warn('[sessions] close failed', e))));
    return ids.length;
  },

  tabOf(sessionId) {
    return Object.entries(get().byTab).find(([, sid]) => sid === sessionId)?.[0];
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

export function useTabSession(tabId: string | null | undefined): SessionInfo | undefined {
  return useSessions((s) => {
    if (!tabId) return undefined;
    const sid = s.byTab[tabId];
    return sid ? s.sessions[sid] : undefined;
  });
}
