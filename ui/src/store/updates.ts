import { create } from 'zustand';
import type { UpdateStatus } from '../platform/bridge';

/** What the update notice shows: a downloaded update (Restart now) or, on ad-hoc signed macOS, an announced one. */
export interface UpdateNotice {
  kind: 'ready' | 'available';
  version: string;
  releaseUrl?: string;
}

interface UpdatesState {
  /** Latest status from the main process (null: browser build or older preload). */
  status: UpdateStatus | null;
  /** "Later" hides the notice for this version until a manual check. */
  dismissed: string | null;
  setStatus(status: UpdateStatus): void;
  dismiss(version: string): void;
  undismiss(): void;
}

export const useUpdates = create<UpdatesState>((set) => ({
  status: null,
  dismissed: null,
  setStatus: (status) => set({ status }),
  dismiss: (version) => set({ dismissed: version }),
  undismiss: () => set({ dismissed: null }),
}));

export function updateNotice(status: UpdateStatus | null, dismissed: string | null): UpdateNotice | null {
  if (!status?.version || status.version === dismissed) return null;
  if (status.state === 'ready' && status.mode === 'install') return { kind: 'ready', version: status.version, releaseUrl: status.releaseUrl };
  if (status.state === 'available' && status.mode === 'notify') return { kind: 'available', version: status.version, releaseUrl: status.releaseUrl };
  return null;
}
