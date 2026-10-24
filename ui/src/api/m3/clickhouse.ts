// `api.clickhouse.*`: ClickHouse module endpoints (plan-batch3 WP-CH). Wire types: ../types.clickhouse.ts. This file is
// part of the initial bundle (api/client.ts): thin request wrappers only, no logic. Writes answer 403 READ_ONLY on
// read-only connections.
import type { M2Http } from '../client';
import type {
  ChActionResult, ChKillMutationRequest, ChMerge, ChMutation, ChOptimizeRequest, ChPartitionRequest, ChPartsResponse,
} from '../types.clickhouse';

export function createClickHouseApi({ json, enc }: M2Http) {
  const p = (cid: string) => `/clickhouse/${enc(cid)}`;
  return {
    parts: (cid: string, database: string, table: string, signal?: AbortSignal) =>
      json<ChPartsResponse>('GET', `${p(cid)}/parts`, { query: { database, table }, signal }),
    mutations: (cid: string, database?: string | null, table?: string | null, signal?: AbortSignal) =>
      json<ChMutation[]>('GET', `${p(cid)}/mutations`, { query: { database: database ?? undefined, table: table ?? undefined }, signal }),
    killMutation: (cid: string, body: ChKillMutationRequest) => json<ChActionResult>('POST', `${p(cid)}/mutations/kill`, { body }),
    merges: (cid: string, database?: string | null, table?: string | null, signal?: AbortSignal) =>
      json<ChMerge[]>('GET', `${p(cid)}/merges`, { query: { database: database ?? undefined, table: table ?? undefined }, signal }),
    optimize: (cid: string, body: ChOptimizeRequest) => json<ChActionResult>('POST', `${p(cid)}/optimize`, { body }),
    dropPartition: (cid: string, body: ChPartitionRequest) => json<ChActionResult>('POST', `${p(cid)}/partitions/drop`, { body }),
    detachPartition: (cid: string, body: ChPartitionRequest) => json<ChActionResult>('POST', `${p(cid)}/partitions/detach`, { body }),
  };
}
