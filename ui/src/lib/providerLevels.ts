// Batch 3 (plan-batch3 1.2): how a provider's catalog levels map onto the console switcher. Pure (no store imports) so
// models and tests can use it; store/connections re-exports it.
import type { ProviderId } from '../api/types';

/**
 * Batch 3: single-level providers whose "schema" is what the console switches (Oracle schema, MySQL/MariaDB/ClickHouse
 * database, Cassandra keyspace): the catalog has no database level and the switcher lists schemas.
 */
export function schemaIsDatabase(providerId: ProviderId | string | null | undefined): boolean {
  return providerId === 'oracle' || providerId === 'mysql' || providerId === 'mariadb' || providerId === 'clickhouse'
    || providerId === 'cassandra';
}

/** Batch 3: what the console switcher calls the level it switches (Oracle schema, Cassandra keyspace, else database). */
export function schemaLevelLabel(providerId: ProviderId | string | null | undefined): 'schema' | 'keyspace' | 'database' {
  return providerId === 'oracle' ? 'schema' : providerId === 'cassandra' ? 'keyspace' : 'database';
}
