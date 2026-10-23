// Elasticsearch / OpenSearch mock pack (plan-batch3 WP-ES): provider entry, sample connection, catalog extras and module routes.
// WP0 stub: the connection is declared but kept out of the mock engine (`connections: []`) until WP-ES adds the
// provider entry, so the existing mock experience and tests do not change. WP-ES owns this file.
import type { ConnectionProfile } from '../../api/types';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"); list it in `connections` together with the provider entry. */
export const elasticsearchConnections: ConnectionProfile[] = [
  { id: 'c_es', name: 'Elasticsearch Dev', providerId: 'elasticsearch', color: null, folder: 'Batch 3', readOnly: false,
      props: { url: 'http://es-dev:9200', auth: 'none', flavor: 'auto' },
      hasPassword: false, savePassword: false, createdAt: PACK_NOW, lastUsedAt: null },
];

export const elasticsearchPack: MockProviderPack = {
  providers: [],
  connections: [],
  extraObjects: {},
  handlers: () => [],
};
