// `api.snowflake.*`: Snowflake module endpoints (plan-batch3 WP-SF). Wire types in ../types.snowflake.ts. Part of the
// initial bundle (api/client.ts): thin request wrappers only, no logic.
import type { M2Http } from '../client';
import type {
  SnowflakeActionResult, SnowflakeDdlResponse, SnowflakeObjectKind, SnowflakeObjectsResponse, SnowflakeRole, SnowflakeSessionContext,
  SnowflakeUseKind, SnowflakeWarehouse,
} from '../types.snowflake';

export function createSnowflakeApi({ json, enc }: M2Http) {
  const c = (cid: string) => `/snowflake/${enc(cid)}`;
  return {
    warehouses: (cid: string) => json<SnowflakeWarehouse[]>('GET', `${c(cid)}/warehouses`),
    warehouseAction: (cid: string, name: string, action: 'resume' | 'suspend') =>
      json<SnowflakeActionResult>('POST', `${c(cid)}/warehouses/${enc(name)}/${action}`),
    roles: (cid: string) => json<SnowflakeRole[]>('GET', `${c(cid)}/roles`),
    objects: (cid: string, kind: SnowflakeObjectKind, database?: string, schema?: string) =>
      json<SnowflakeObjectsResponse>('GET', `${c(cid)}/objects`, { query: { kind, database, schema } }),
    objectDdl: (cid: string, kind: SnowflakeObjectKind, name: string, database?: string, schema?: string) =>
      json<SnowflakeDdlResponse>('GET', `${c(cid)}/objects/ddl`, { query: { kind, name, database, schema } }),
    objectAction: (cid: string, body: { kind: SnowflakeObjectKind; name: string; action: string; database?: string; schema?: string }) =>
      json<SnowflakeActionResult>('POST', `${c(cid)}/objects/action`, { body }),
    sessionContext: (sid: string) => json<SnowflakeSessionContext>('GET', `/snowflake/sessions/${enc(sid)}/context`),
    use: (sid: string, kind: SnowflakeUseKind, name: string) =>
      json<SnowflakeSessionContext>('POST', `/snowflake/sessions/${enc(sid)}/use`, { body: { kind, name } }),
  };
}
