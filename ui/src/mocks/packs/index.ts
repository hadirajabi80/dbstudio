// Batch 3 mock packs (plan-batch3 WP0). One per work package; this list never changes after WP0.
import type { MockProviderPack } from './types';
import { mysqlPack } from './mysql';
import { clickhousePack } from './clickhouse';
import { snowflakePack } from './snowflake';
import { cassandraPack } from './cassandra';
import { elasticsearchPack } from './elasticsearch';

export const MOCK_PACKS: readonly MockProviderPack[] = [mysqlPack, clickhousePack, snowflakePack, cassandraPack, elasticsearchPack];

export type { MockProviderPack } from './types';
