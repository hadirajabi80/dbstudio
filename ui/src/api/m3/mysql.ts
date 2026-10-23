// `api.mysql.*`: MySQL / MariaDB module endpoints (plan-batch3 WP-MY). Wire types go in ../types.mysql.ts. This file is
// part of the initial bundle (api/client.ts): thin request wrappers only, no logic.
// WP0 stub: no endpoints yet; WP-MY owns this file.
import type { M2Http } from '../client';

export function createMySqlApi(http: M2Http) {
  void http;
  return {};
}
