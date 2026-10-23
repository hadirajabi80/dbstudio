// Batch 3 feature namespaces of the REST client (`api.mysql.*`, `api.clickhouse.*`, `api.snowflake.*`,
// `api.cassandra.*`, `api.es.*`), spread into `api` by ./client.ts. Each work package owns its ./m3/<name>.ts file
// (and ./types.<name>.ts); this file never changes after WP0.
import type { M2Http } from './client';
import { createMySqlApi } from './m3/mysql';
import { createClickHouseApi } from './m3/clickhouse';
import { createSnowflakeApi } from './m3/snowflake';
import { createCassandraApi } from './m3/cassandra';
import { createEsApi } from './m3/es';

export function createM3Namespaces(http: M2Http) {
  return {
    mysql: createMySqlApi(http),
    clickhouse: createClickHouseApi(http),
    snowflake: createSnowflakeApi(http),
    cassandra: createCassandraApi(http),
    es: createEsApi(http),
  };
}
