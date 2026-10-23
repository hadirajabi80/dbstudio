// `api.clickhouse.*`: ClickHouse module endpoints (plan-batch3 WP-CH). Wire types go in ../types.clickhouse.ts. This file is
// part of the initial bundle (api/client.ts): thin request wrappers only, no logic.
// WP0 stub: no endpoints yet; WP-CH owns this file.
import type { M2Http } from '../client';

export function createClickHouseApi(http: M2Http) {
  void http;
  return {};
}
