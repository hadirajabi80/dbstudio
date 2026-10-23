// Snowflake mock pack (plan-batch3 WP-SF): provider entry, sample connection, catalog extras and module routes.
// WP0 stub: the connection is declared but kept out of the mock engine (`connections: []`) until WP-SF adds the
// provider entry, so the existing mock experience and tests do not change. WP-SF owns this file.
import type { ConnectionProfile } from '../../api/types';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"); list it in `connections` together with the provider entry. */
export const snowflakeConnections: ConnectionProfile[] = [
  { id: 'c_snowflake', name: 'Snowflake Shop', providerId: 'snowflake', color: null, folder: 'Batch 3', readOnly: false,
      props: { account: 'xy12345.eu-central-1', user: 'SHOP', authenticator: 'snowflake', warehouse: 'COMPUTE_WH', database: 'SHOP', schema: 'PUBLIC' },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
];

export const snowflakePack: MockProviderPack = {
  providers: [],
  connections: [],
  extraObjects: {},
  handlers: () => [],
};
