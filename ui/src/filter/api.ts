// Saved filters REST (PLAN-M1.5 3.7 `/filters`), through the engine client.
import { api } from '../api/client';
import type { SavedFilterInput, SavedFilterPatch } from './wire';

export const filtersApi = {
  list: (connectionId: string, signature?: string | null) => api.listFilters(connectionId, signature),
  create: (f: SavedFilterInput) => api.createFilter(f),
  update: (id: string, patch: SavedFilterPatch) => api.updateFilter(id, patch),
  remove: (id: string) => api.deleteFilter(id),
};
