// Wire types of the Snowflake module endpoints (plan-batch3 WP-SF; engine SnowflakeObjects / SnowflakeSessionContext).

export interface SnowflakeWarehouse {
  name: string;
  /** STARTED | SUSPENDED | RESIZING | RESUMING … */
  state: string;
  type: string | null;
  size: string | null;
  minClusters: number | null;
  maxClusters: number | null;
  running: number | null;
  queued: number | null;
  autoSuspendSeconds: number | null;
  autoResume: boolean;
  isCurrent: boolean;
  isDefault: boolean;
  owner: string | null;
  comment: string | null;
  scalingPolicy: string | null;
  createdOn: string | null;
}

export interface SnowflakeRole {
  name: string;
  isCurrent: boolean;
  isDefault: boolean;
  owner: string | null;
  comment: string | null;
}

export type SnowflakeObjectKind = 'stages' | 'streams' | 'tasks' | 'pipes' | 'fileformats' | 'dynamictables' | 'alerts';

export interface SnowflakeObject {
  kind: SnowflakeObjectKind;
  name: string;
  database: string | null;
  schema: string | null;
  owner: string | null;
  comment: string | null;
  createdOn: string | null;
  state: string | null;
  details: Record<string, string>;
}

export interface SnowflakeObjectsResponse {
  database: string;
  schema: string;
  kind: SnowflakeObjectKind;
  items: SnowflakeObject[];
  /** Why the list is empty (privilege), else null. */
  note: string | null;
}

export interface SnowflakeDdlResponse {
  kind: SnowflakeObjectKind;
  name: string;
  ddl: string;
  source: 'stored' | 'generated';
}

export interface SnowflakeActionResult {
  ok: boolean;
  message: string | null;
}

export interface SnowflakeSessionContext {
  warehouse: string | null;
  role: string | null;
  database: string | null;
  schema: string | null;
  secondaryRoles: string | null;
  sessionId: string | null;
}

export type SnowflakeUseKind = 'warehouse' | 'role' | 'database' | 'schema';
