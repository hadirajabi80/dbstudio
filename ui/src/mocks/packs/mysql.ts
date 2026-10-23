// MySQL + MariaDB mock pack (plan-batch3 WP-MY): provider entry, sample connection, catalog extras and module routes.
// WP0 stub: the connection is declared but kept out of the mock engine (`connections: []`) until WP-MY adds the
// provider entry, so the existing mock experience and tests do not change. WP-MY owns this file.
import type { ConnectionProfile } from '../../api/types';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"); list it in `connections` together with the provider entry. */
export const mysqlConnections: ConnectionProfile[] = [
  { id: 'c_mysql', name: 'MySQL Shop', providerId: 'mysql', color: null, folder: 'Batch 3', readOnly: false,
      props: { host: 'mysql-dev', port: 3306, database: 'shop', user: 'shop' },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
];

export const mysqlPack: MockProviderPack = {
  providers: [],
  connections: [],
  extraObjects: {},
  handlers: () => [],
};
