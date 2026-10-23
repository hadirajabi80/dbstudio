// Batch 3 (plan-batch3 WP0): a work package's contribution to the mock engine (dev:mock and component tests), spread
// by mocks/fixtures.ts (providers, connections), mocks/engine.ts (catalog extras) and mocks/handlers.ts (routes).
// Packs must not import fixtures.ts / engine.ts / handlers.ts at runtime (they import the packs): type imports only.
import type { RequestHandler } from 'msw';
import type { CatalogObject, ConnectionProfile, ProviderInfo } from '../../api/types';
import type { M2MockContext } from '../m2';

export interface MockProviderPack {
  /** Entries appended to GET /providers. */
  providers: ProviderInfo[];
  /** Connections appended to the initial mock connections (convention: folder "Batch 3"). */
  connections: ConnectionProfile[];
  /** Catalog objects added to the shop schema of these provider ids (on top of the SQLite shop tables). */
  extraObjects: Record<string, CatalogObject[]>;
  /** The pack's REST routes (module endpoints such as /mysql/…, /es/{cid}/…). */
  handlers(ctx: M2MockContext): RequestHandler[];
}

/** Creation time of the pack connections (same as the other mock connections). */
export const PACK_NOW = '2026-10-14T09:00:00Z';
