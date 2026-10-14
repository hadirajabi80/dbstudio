// Query parameters (PLAN-M1.5 A2): the pending Parameters dialog request, per-tab "don't ask again", and MRU
// values per connection and name (persisted in Settings.ui.paramHistory).
import { create } from 'zustand';
import type { Dialect, ParamKind, QueryParam } from '../api/types';
import { useSettings } from './settings';

export interface ParamRow {
  name: string;
  display: string;
  positional: boolean;
  kind: ParamKind;
  value: string;
}

export interface ParamsRequest {
  tabId: string;
  connectionId: string;
  dialect: Dialect;
  rows: ParamRow[];
  resolve(params: QueryParam[] | null): void;
}

export interface ParamMemory {
  kind: ParamKind;
  /** Most recent first. */
  values: string[];
}

export type ParamHistory = Record<string, Record<string, ParamMemory>>;

const MRU_MAX = 10;

export function paramHistory(): ParamHistory {
  return (useSettings.getState().settings.ui?.paramHistory as ParamHistory | undefined) ?? {};
}

export function rememberParams(connectionId: string, rows: ParamRow[]): void {
  const all = paramHistory();
  const mine = { ...(all[connectionId] ?? {}) };
  for (const r of rows) {
    if (r.positional) continue;
    const key = r.name.toLowerCase();
    const prev = mine[key]?.values ?? [];
    const values = r.kind === 'null' || r.kind === 'refcursor' ? prev : [r.value, ...prev.filter((v) => v !== r.value)].slice(0, MRU_MAX);
    mine[key] = { kind: r.kind, values };
  }
  useSettings.getState().update({ ui: { paramHistory: { ...all, [connectionId]: mine } } });
}

export function recalled(connectionId: string, name: string): ParamMemory | undefined {
  return paramHistory()[connectionId]?.[name.toLowerCase()];
}

interface ParamsState {
  request: ParamsRequest | null;
  /** Tabs where every parameter was remembered and the user chose "Don't ask again". */
  skip: Record<string, boolean>;
  open(req: ParamsRequest): void;
  close(params: QueryParam[] | null): void;
  setSkip(tabId: string, on: boolean): void;
}

export const useParams = create<ParamsState>((set, get) => ({
  request: null,
  skip: {},
  open(req) {
    get().request?.resolve(null);
    set({ request: req });
  },
  close(params) {
    const r = get().request;
    set({ request: null });
    r?.resolve(params);
  },
  setSkip(tabId, on) {
    set({ skip: { ...get().skip, [tabId]: on } });
  },
}));
