// Cassandra / ScyllaDB mock pack (plan-batch3 WP-CS): provider entry, sample connection, catalog extras and module routes.
// WP0 stub: the connection is declared but kept out of the mock engine (`connections: []`) until WP-CS adds the
// provider entry, so the existing mock experience and tests do not change. WP-CS owns this file.
import type { ConnectionProfile } from '../../api/types';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"); list it in `connections` together with the provider entry. */
export const cassandraConnections: ConnectionProfile[] = [
  { id: 'c_cassandra', name: 'Cassandra Shop', providerId: 'cassandra', color: null, folder: 'Batch 3', readOnly: false,
      props: { contactPoints: 'cassandra-dev', port: 9042, localDc: 'datacenter1', keyspace: 'shop' },
      hasPassword: false, savePassword: false, createdAt: PACK_NOW, lastUsedAt: null },
];

export const cassandraPack: MockProviderPack = {
  providers: [],
  connections: [],
  extraObjects: {},
  handlers: () => [],
};
