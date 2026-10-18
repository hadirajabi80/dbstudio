// M2 (docs/PLAN-M2.md D2, 1.3): the engine's long-lived Redis/MongoDB/Kafka clients ("Clients" in the Connections
// panel, connection activity dots, status bar count). Fed by GET /sources/clients and the `source.client` WS event.
import { create } from 'zustand';
import { api } from '../api/client';
import type { SourceClientInfo, SourceClientState } from '../api/types';

interface SourceClientsState {
  clients: Record<string, SourceClientInfo>;
  loaded: boolean;
  refresh(): Promise<void>;
  /** `source.client` event: open → refetch the details, closed/broken → drop. */
  apply(connectionId: string, state: SourceClientState): void;
  /** Disconnect (DELETE /sources/{cid}/client); streams on the client end on the engine. */
  close(connectionId: string): Promise<void>;
  /** Engine restart: every client is gone. */
  reset(): void;
}

let refreshing: Promise<void> | null = null;

export const useSourceClients = create<SourceClientsState>((set, get) => ({
  clients: {},
  loaded: false,
  refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const list = await api.sourceClients();
        set({ clients: Object.fromEntries(list.map((c) => [c.connectionId, c])), loaded: true });
      } catch {
        set({ loaded: true });
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },
  apply(connectionId, state) {
    if (state === 'open') {
      void get().refresh();
      return;
    }
    const next = { ...get().clients };
    delete next[connectionId];
    set({ clients: next });
  },
  async close(connectionId) {
    await api.closeSourceClient(connectionId);
    get().apply(connectionId, 'closed');
  },
  reset: () => set({ clients: {} }),
}));

export function sourceClientOpen(connectionId: string): boolean {
  return !!useSourceClients.getState().clients[connectionId];
}
