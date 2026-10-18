import { create } from 'zustand';
import { api } from '../api/client';
import type { ConnectionInput, ConnectionProfile, Dialect, ProviderId, ProviderInfo, SourceKind, TestConnectionRequest } from '../api/types';

interface ConnectionsState {
  providers: ProviderInfo[];
  connections: ConnectionProfile[];
  loaded: boolean;
  error: string | null;
  load(): Promise<void>;
  save(input: ConnectionInput, id?: string): Promise<ConnectionProfile>;
  /**
   * DELETE /connections/{id}. The engine answers 409 TX_OPEN while a session of the connection has an open
   * transaction; `force` (after the user confirmed rolling back) deletes anyway.
   */
  remove(id: string, opts?: { force?: boolean }): Promise<void>;
  test(req: TestConnectionRequest): ReturnType<typeof api.testConnection>;
  /** Locally mark a connection as used (the engine updates lastUsedAt itself on session open). */
  touch(id: string): void;
}

let loading: Promise<void> | null = null;

export const useConnections = create<ConnectionsState>((set, get) => ({
  providers: [],
  connections: [],
  loaded: false,
  error: null,
  load() {
    // Concurrent callers share one request pair (boot + retry banner, StrictMode).
    if (loading) return loading;
    loading = (async () => {
      try {
        const [providers, connections] = await Promise.all([api.providers(), api.listConnections()]);
        set({ providers, connections, loaded: true, error: null });
      } catch (e) {
        set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
      } finally {
        loading = null;
      }
    })();
    return loading;
  },
  async save(input, id) {
    const saved = id ? await api.updateConnection(id, input) : await api.createConnection(input);
    const list = get().connections;
    const idx = list.findIndex((c) => c.id === saved.id);
    set({ connections: idx >= 0 ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved] });
    return saved;
  },
  async remove(id, opts = {}) {
    // DELETE …?force=true rolls back and closes sessions the caller could not close first (else 409 TX_OPEN).
    await api.deleteConnection(id, { force: opts.force === true });
    set({ connections: get().connections.filter((c) => c.id !== id) });
  },
  test: (req) => api.testConnection(req),
  touch(id) {
    const now = new Date().toISOString();
    set({ connections: get().connections.map((c) => (c.id === id ? { ...c, lastUsedAt: now } : c)) });
  },
}));

export function getConnection(id: string | null | undefined): ConnectionProfile | undefined {
  if (!id) return undefined;
  return useConnections.getState().connections.find((c) => c.id === id);
}

export function getProvider(providerId: string | undefined): ProviderInfo | undefined {
  return useConnections.getState().providers.find((p) => p.id === providerId);
}

const FALLBACK_DIALECT: Record<string, Dialect> = { sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite', postgresql: 'pgsql' };

/** M2: provider kinds when the engine's provider list is not loaded yet (or an older engine omits `kind`). */
const FALLBACK_KIND: Record<string, SourceKind> = {
  sqlserver: 'relational', oracle: 'relational', sqlite: 'relational', postgresql: 'relational',
  redis: 'keyvalue', mongodb: 'document', kafka: 'stream',
};

/** M2 (docs/PLAN-M2.md D1): kind of a provider id; unknown ids count as relational (M1 behaviour). */
export function providerKind(providerId: string | null | undefined): SourceKind {
  if (!providerId) return 'relational';
  return getProvider(providerId)?.kind ?? FALLBACK_KIND[providerId] ?? 'relational';
}

/** M2: kind of a connection's provider ('relational' for unknown connections). */
export function kindOf(connectionId: string | null | undefined): SourceKind {
  return providerKind(getConnection(connectionId)?.providerId);
}

export function isRelational(connectionId: string | null | undefined): boolean {
  return kindOf(connectionId) === 'relational';
}

/** M2: providers with a database level above schemas that a console can switch (SQL Server, PostgreSQL). */
export function hasDatabaseLevel(providerId: ProviderId | string | null | undefined): boolean {
  return providerId === 'sqlserver' || providerId === 'postgresql';
}

/**
 * SQL dialect of a connection. Unknown connections and non-relational sources fall back to 'sqlite' so SQL-only code
 * paths keep a valid dialect; use `dialectOrNull` where a non-relational connection must be told apart.
 */
export function dialectOf(connectionId: string | null | undefined): Dialect {
  const c = getConnection(connectionId);
  if (!c) return 'sqlite';
  return getProvider(c.providerId)?.dialect ?? FALLBACK_DIALECT[c.providerId] ?? 'sqlite';
}

/** M2: the SQL dialect of a relational connection, null for Redis/MongoDB/Kafka (and unknown connections). */
export function dialectOrNull(connectionId: string | null | undefined): Dialect | null {
  const c = getConnection(connectionId);
  if (!c || providerKind(c.providerId) !== 'relational') return null;
  return getProvider(c.providerId)?.dialect ?? FALLBACK_DIALECT[c.providerId] ?? null;
}

export function useConnection(id: string | null | undefined): ConnectionProfile | undefined {
  return useConnections((s) => (id ? s.connections.find((c) => c.id === id) : undefined));
}

/** M2: kind of a connection's provider, reactive. */
export function useSourceKind(connectionId: string | null | undefined): SourceKind {
  return useConnections((s) => {
    const c = connectionId ? s.connections.find((x) => x.id === connectionId) : undefined;
    if (!c) return 'relational';
    return s.providers.find((p) => p.id === c.providerId)?.kind ?? FALLBACK_KIND[c.providerId] ?? 'relational';
  });
}

export function useDialect(connectionId: string | null | undefined): Dialect {
  return useConnections((s) => {
    const c = connectionId ? s.connections.find((x) => x.id === connectionId) : undefined;
    if (!c) return 'sqlite';
    return s.providers.find((p) => p.id === c.providerId)?.dialect ?? FALLBACK_DIALECT[c.providerId] ?? 'sqlite';
  });
}
