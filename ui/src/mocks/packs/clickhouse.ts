// ClickHouse mock pack (plan-batch3 WP-CH): provider entry, sample connection, catalog extras and module routes.
// WP0 stub: the connection is declared but kept out of the mock engine (`connections: []`) until WP-CH adds the
// provider entry, so the existing mock experience and tests do not change. WP-CH owns this file.
import type { ConnectionProfile } from '../../api/types';
import { PACK_NOW, type MockProviderPack } from './types';

/** The pack's sample connection (folder "Batch 3"); list it in `connections` together with the provider entry. */
export const clickhouseConnections: ConnectionProfile[] = [
  { id: 'c_clickhouse', name: 'ClickHouse Shop', providerId: 'clickhouse', color: null, folder: 'Batch 3', readOnly: false,
      props: { host: 'clickhouse-dev', port: 8123, database: 'shop', user: 'shop' },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
];

export const clickhousePack: MockProviderPack = {
  providers: [],
  connections: [],
  extraObjects: {},
  handlers: () => [],
};
