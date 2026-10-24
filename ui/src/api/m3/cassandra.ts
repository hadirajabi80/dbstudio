// `api.cassandra.*`: Cassandra module endpoints (plan-batch3 WP-CS). Wire types: ../types.cassandra.ts. This file is
// part of the initial bundle (api/client.ts): thin request wrappers only, no logic.
import type { M2Http } from '../client';
import type {
  CqlClientConnection, CqlClusterInfo, CqlSessionSettings, CqlSessionSettingsPatch, CqlTableInfo, CqlTrace, CqlTraceSummary,
} from '../types.cassandra';

export function createCassandraApi({ json, enc }: M2Http) {
  const s = (sid: string) => `/cassandra/sessions/${enc(sid)}`;
  const c = (cid: string) => `/cassandra/${enc(cid)}`;
  return {
    sessionSettings: (sid: string) => json<CqlSessionSettings>('GET', `${s(sid)}/settings`),
    setSessionSettings: (sid: string, patch: CqlSessionSettingsPatch) => json<CqlSessionSettings>('PUT', `${s(sid)}/settings`, { body: patch }),
    sessionTraces: (sid: string) => json<CqlTraceSummary[]>('GET', `${s(sid)}/traces`),
    trace: (cid: string, traceId: string) => json<CqlTrace>('GET', `${c(cid)}/traces/${enc(traceId)}`),
    cluster: (cid: string) => json<CqlClusterInfo>('GET', `${c(cid)}/cluster`),
    clients: (cid: string) => json<CqlClientConnection[]>('GET', `${c(cid)}/clients`),
    tableInfo: (cid: string, keyspace: string, name: string) =>
      json<CqlTableInfo>('GET', `${c(cid)}/keyspaces/${enc(keyspace)}/tables/${enc(name)}`),
  };
}
