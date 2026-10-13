import { create } from 'zustand';
import { api } from '../api/client';
import type { ConnectionInput, ConnectionProfile, Dialect, ProviderInfo, TestConnectionRequest } from '../api/types';

interface ConnectionsState {
  providers: ProviderInfo[];
  connections: ConnectionProfile[];
  loaded: boolean;
  error: string | null;
  load(): Promise<void>;
  save(input: ConnectionInput, id?: string): Promise<ConnectionProfile>;
  remove(id: string): Promise<void>;
  test(req: TestConnectionRequest): ReturnType<typeof api.testConnection>;
  /** Locally mark a connection as used (the engine updates lastUsedAt itself on session open). */
  touch(id: string): void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  providers: [],
  connections: [],
  loaded: false,
  error: null,
  async load() {
    try {
      const [providers, connections] = await Promise.all([api.providers(), api.listConnections()]);
      set({ providers, connections, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },
  async save(input, id) {
    const saved = id ? await api.updateConnection(id, input) : await api.createConnection(input);
    const list = get().connections;
    const idx = list.findIndex((c) => c.id === saved.id);
    set({ connections: idx >= 0 ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved] });
    return saved;
  },
  async remove(id) {
    await api.deleteConnection(id);
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

const FALLBACK_DIALECT: Record<string, Dialect> = { sqlserver: 'tsql', oracle: 'plsql', sqlite: 'sqlite' };

export function dialectOf(connectionId: string | null | undefined): Dialect {
  const c = getConnection(connectionId);
  if (!c) return 'sqlite';
  return getProvider(c.providerId)?.dialect ?? FALLBACK_DIALECT[c.providerId] ?? 'sqlite';
}

export function useConnection(id: string | null | undefined): ConnectionProfile | undefined {
  return useConnections((s) => (id ? s.connections.find((c) => c.id === id) : undefined));
}

export function useDialect(connectionId: string | null | undefined): Dialect {
  return useConnections((s) => {
    const c = connectionId ? s.connections.find((x) => x.id === connectionId) : undefined;
    if (!c) return 'sqlite';
    return s.providers.find((p) => p.id === c.providerId)?.dialect ?? FALLBACK_DIALECT[c.providerId] ?? 'sqlite';
  });
}
