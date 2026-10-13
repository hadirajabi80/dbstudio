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
