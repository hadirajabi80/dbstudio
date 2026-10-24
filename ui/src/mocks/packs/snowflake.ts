// Snowflake mock pack (plan-batch3 WP-SF): provider entry, sample connection, catalog extras and module routes
// (/snowflake/{cid}/warehouses, roles, objects, objects/ddl, objects/action, /snowflake/sessions/{sid}/context, use).
// The data mirrors the engine's recorded fixtures (engine/tests/DbStudio.Providers.Snowflake.Tests/Fixtures).
// `shop` (MockProviderPack.shop) makes the mock engine present database SHOP with schemas PUBLIC and ANALYTICS.
import { http, HttpResponse, type RequestHandler } from 'msw';
import type { CatalogObject, ConnectionProfile, ProviderInfo } from '../../api/types';
import type {
  SnowflakeObject, SnowflakeObjectKind, SnowflakeRole, SnowflakeSessionContext, SnowflakeUseKind, SnowflakeWarehouse,
} from '../../api/types.snowflake';
import { PACK_NOW, type MockProviderPack } from './types';

const P = '*/api/v1';

/** The pack's sample connection (folder "Batch 3"). */
export const snowflakeConnections: ConnectionProfile[] = [
  { id: 'c_snowflake', name: 'Snowflake Shop', providerId: 'snowflake', color: '#1f8ac7', folder: 'Batch 3', readOnly: false,
      props: { account: 'xy12345.eu-central-1', user: 'SHOP', authenticator: 'snowflake', warehouse: 'COMPUTE_WH', database: 'SHOP', schema: 'PUBLIC', role: 'SYSADMIN', queryTag: 'Rowlit' },
      hasPassword: true, savePassword: true, createdAt: PACK_NOW, lastUsedAt: null },
];

const when = (authenticator: string) => ({ authenticator });

export const snowflakeProvider: ProviderInfo = {
  id: 'snowflake',
  displayName: 'Snowflake',
  dialect: 'snowflake',
  kind: 'relational',
  formSpec: {
    fields: [
      { key: 'account', label: 'Account', type: 'text', required: true, placeholder: 'orgname-account or xy12345.eu-central-1', help: 'Account identifier (the part before .snowflakecomputing.com); a full URL is accepted too.' },
      { key: 'user', label: 'User', type: 'text', placeholder: 'JSMITH', help: 'Login name (optional for OAuth when the token names the user).' },
      { key: 'authenticator', label: 'Authentication', type: 'select', default: 'snowflake', options: [
        { value: 'snowflake', label: 'Password' }, { value: 'snowflake_jwt', label: 'Key pair (JWT)' },
        { value: 'externalbrowser', label: 'Browser SSO (externalbrowser)' }, { value: 'oauth', label: 'OAuth access token' },
      ] },
      { key: 'password', label: 'Password', type: 'password', visibleWhen: when('snowflake') },
      { key: 'privateKeyFile', label: 'Private key file', type: 'file', visibleWhen: when('snowflake_jwt'), fileFilter: '*.p8;*.pem;*.key', help: 'PKCS#8 private key (rsa_key.p8) whose public key is set on the user (ALTER USER … SET RSA_PUBLIC_KEY).' },
      { key: 'privateKeyPassphrase', label: 'Key passphrase', type: 'password', visibleWhen: when('snowflake_jwt'), help: 'Only for an encrypted key (ENCRYPTED PRIVATE KEY).' },
      { key: 'token', label: 'OAuth token', type: 'password', visibleWhen: when('oauth'), help: 'Access token from your identity provider (it expires: paste a fresh one when Snowflake rejects it).' },
      { key: 'warehouse', label: 'Warehouse', type: 'text', placeholder: 'COMPUTE_WH' },
      { key: 'database', label: 'Database', type: 'text', placeholder: 'SNOWFLAKE_SAMPLE_DATA' },
      { key: 'schema', label: 'Schema', type: 'text', placeholder: 'PUBLIC' },
      { key: 'role', label: 'Role', type: 'text', placeholder: 'SYSADMIN', help: "Empty = the user's default role." },
      { key: 'host', label: 'Host (advanced)', type: 'text', placeholder: 'account.privatelink.snowflakecomputing.com', help: 'Only for PrivateLink or custom hosts; derived from the account otherwise.' },
      { key: 'clientSessionKeepAlive', label: 'Keep session alive', type: 'bool', default: false, help: 'Heartbeats keep idle tabs logged in beyond the 4-hour session timeout.' },
      { key: 'connectTimeout', label: 'Connect timeout (s)', type: 'number', default: 60 },
      { key: 'queryTag', label: 'Query tag', type: 'text', default: 'Rowlit', help: 'QUERY_TAG of every statement (shows in QUERY_HISTORY).' },
    ],
  },
};

/** Snowflake-only objects on top of the SQLite shop tables of the mock engine. */
export const SNOWFLAKE_EXTRA_OBJECTS: CatalogObject[] = [
  { t: 'mview', n: 'order_totals_mv', cm: 'Revenue per customer (materialized view)', c: [['customer_id', 'NUMBER(38,0)', 0, 0, 0, null], ['total', 'NUMBER(38,2)', 1, 0, 0, null]] },
  { t: 'table', n: 'events_raw', cm: 'Landing table for the PIPE (transient)', c: [['payload', 'VARIANT', 1, 0, 0, null], ['loaded_at', 'TIMESTAMP_LTZ(9)', 1, 0, 0, null]] },
  { t: 'proc', n: 'refresh_totals', cm: 'Recomputes ORDERS.TOTAL', p: [['DAYS', 'NUMBER', 'in', 0]] },
  { t: 'func', n: 'order_tax', cm: null, p: [['AMOUNT', 'NUMBER', 'in', 0], ['', 'NUMBER(38,2)', 'return', 0]] },
  { t: 'tablefunc', n: 'orders_of', cm: 'Orders of one customer', p: [['ARG1', 'NUMBER', 'in', 0]], c: [['ORDER_ID', 'NUMBER', 1, 0, 0, null], ['TOTAL', 'NUMBER', 1, 0, 0, null]] },
  { t: 'sequence', n: 'orders_seq', cm: 'Order numbers' },
];

export const MOCK_WAREHOUSES: SnowflakeWarehouse[] = [
  { name: 'COMPUTE_WH', state: 'SUSPENDED', type: 'STANDARD', size: 'X-Small', minClusters: 1, maxClusters: 1, running: 0, queued: 0, autoSuspendSeconds: 600, autoResume: true, isCurrent: true, isDefault: true, owner: 'ACCOUNTADMIN', comment: null, scalingPolicy: 'STANDARD', createdOn: '2026-09-30 07:58:45.010 -0700' },
  { name: 'ETL_WH', state: 'STARTED', type: 'STANDARD', size: 'Small', minClusters: 1, maxClusters: 3, running: 2, queued: 1, autoSuspendSeconds: 60, autoResume: true, isCurrent: false, isDefault: false, owner: 'SYSADMIN', comment: 'Nightly loads', scalingPolicy: 'ECONOMY', createdOn: '2026-10-01 10:00:00.000 -0700' },
  { name: 'BI_WH', state: 'SUSPENDED', type: 'SNOWPARK-OPTIMIZED', size: 'Medium', minClusters: 1, maxClusters: 1, running: 0, queued: 0, autoSuspendSeconds: 300, autoResume: false, isCurrent: false, isDefault: false, owner: 'SYSADMIN', comment: 'Dashboards', scalingPolicy: 'STANDARD', createdOn: '2026-10-05 12:00:00.000 -0700' },
];

export const MOCK_ROLES: SnowflakeRole[] = [
  { name: 'ANALYST', isCurrent: false, isDefault: false, owner: 'SECURITYADMIN', comment: 'Read-only analysts' },
  { name: 'PUBLIC', isCurrent: false, isDefault: false, owner: null, comment: 'Public role is automatically available to every user in the account.' },
  { name: 'SYSADMIN', isCurrent: true, isDefault: true, owner: null, comment: 'System administrator can create and manage databases and warehouses.' },
];

const o = (kind: SnowflakeObjectKind, name: string, state: string | null, details: Record<string, string>, comment: string | null = null): SnowflakeObject =>
  ({ kind, name, database: 'SHOP', schema: 'PUBLIC', owner: 'SYSADMIN', comment, createdOn: '2026-10-01 10:00:00.000 -0700', state, details });

export const MOCK_OBJECTS: Record<SnowflakeObjectKind, SnowflakeObject[]> = {
  stages: [
    o('stages', 'EVENTS_STAGE', null, { url: 's3://rowlit-demo/events/', type: 'EXTERNAL', cloud: 'AWS', region: 'eu-central-1', storage_integration: 'S3_INT' }),
    o('stages', 'UPLOADS', null, { type: 'INTERNAL', directory_enabled: 'Y' }, 'Internal stage for PUT'),
  ],
  streams: [o('streams', 'ORDERS_CHANGES', null, { table_name: 'SHOP.PUBLIC.ORDERS', source_type: 'Table', type: 'DELTA', mode: 'DEFAULT', stale: 'false' })],
  tasks: [
    o('tasks', 'NIGHTLY_TOTALS', 'started', { warehouse: 'ETL_WH', schedule: 'USING CRON 0 2 * * * UTC', definition: 'CALL REFRESH_TOTALS(1)' }, 'Runs REFRESH_TOTALS'),
    o('tasks', 'PURGE_EVENTS', 'suspended', { warehouse: 'ETL_WH', schedule: '60 MINUTE', definition: "DELETE FROM EVENTS_RAW WHERE LOADED_AT < DATEADD(day, -30, CURRENT_TIMESTAMP())" }),
  ],
  pipes: [o('pipes', 'EVENTS_PIPE', null, { definition: 'COPY INTO EVENTS_RAW FROM @EVENTS_STAGE FILE_FORMAT = (TYPE = JSON)', notification_channel: 'arn:aws:sqs:eu-central-1:000000000000:sf-snowpipe' })],
  fileformats: [o('fileformats', 'CSV_PIPE', null, { type: 'CSV', format_options: '{"FIELD_DELIMITER":"|","SKIP_HEADER":1}' })],
  dynamictables: [o('dynamictables', 'DAILY_REVENUE', 'ACTIVE', { target_lag: '1 hour', warehouse: 'ETL_WH', refresh_mode: 'INCREMENTAL', rows: '31' }, 'Revenue per day')],
  alerts: [],
};

const DDL: Record<string, string> = {
  'tasks:NIGHTLY_TOTALS': "create or replace task SHOP.PUBLIC.NIGHTLY_TOTALS\n\twarehouse=ETL_WH\n\tschedule='USING CRON 0 2 * * * UTC'\n\tCOMMENT='Runs REFRESH_TOTALS'\n\tas CALL REFRESH_TOTALS(1);\n",
  'streams:ORDERS_CHANGES': 'create or replace stream SHOP.PUBLIC.ORDERS_CHANGES on table ORDERS;\n',
  'pipes:EVENTS_PIPE': 'create or replace pipe SHOP.PUBLIC.EVENTS_PIPE auto_ingest=true as COPY INTO EVENTS_RAW FROM @EVENTS_STAGE FILE_FORMAT = (TYPE = JSON);\n',
  'stages:UPLOADS': '-- DESCRIBE STAGE SHOP.PUBLIC.UPLOADS\n-- STAGE_FILE_FORMAT\n--   FIELD_DELIMITER = |\n-- DIRECTORY\n--   ENABLE = true\n',
};

/** Session contexts per mock session id (USE … changes them). */
const contexts = new Map<string, SnowflakeSessionContext>();

function contextOf(sid: string): SnowflakeSessionContext {
  let c = contexts.get(sid);
  if (!c) contexts.set(sid, (c = { warehouse: 'COMPUTE_WH', role: 'SYSADMIN', database: 'SHOP', schema: 'PUBLIC', secondaryRoles: '{"roles":"","value":""}', sessionId: '17592186044422' }));
  return c;
}

const notFound = (what: string) => HttpResponse.json({ code: 'NOT_FOUND', message: `${what} was not found.` }, { status: 404 });

export function snowflakeHandlers(): RequestHandler[] {
  return [
    http.get(`${P}/snowflake/:cid/warehouses`, () => HttpResponse.json(MOCK_WAREHOUSES)),
    http.post(`${P}/snowflake/:cid/warehouses/:name/:action`, ({ params }) => {
      const w = MOCK_WAREHOUSES.find((x) => x.name === params.name);
      if (!w) return notFound(`Warehouse ${String(params.name)}`);
      w.state = params.action === 'resume' ? 'STARTED' : 'SUSPENDED';
      return HttpResponse.json({ ok: true, message: 'Statement executed successfully.' });
    }),
    http.get(`${P}/snowflake/:cid/roles`, () => HttpResponse.json(MOCK_ROLES)),
    http.get(`${P}/snowflake/:cid/objects`, ({ request }) => {
      const url = new URL(request.url);
      const kind = (url.searchParams.get('kind') ?? 'stages') as SnowflakeObjectKind;
      return HttpResponse.json({ database: url.searchParams.get('database') ?? 'SHOP', schema: url.searchParams.get('schema') ?? 'PUBLIC', kind, items: MOCK_OBJECTS[kind] ?? [], note: null });
    }),
    http.get(`${P}/snowflake/:cid/objects/ddl`, ({ request }) => {
      const url = new URL(request.url);
      const kind = url.searchParams.get('kind') ?? '';
      const name = url.searchParams.get('name') ?? '';
      const ddl = DDL[`${kind}:${name}`] ?? `create or replace ${kind.replace(/s$/, '')} SHOP.PUBLIC.${name};\n`;
      return HttpResponse.json({ kind, name, ddl, source: kind === 'stages' ? 'generated' : 'stored' });
    }),
    http.post(`${P}/snowflake/:cid/objects/action`, async ({ request }) => {
      const body = (await request.json()) as { kind: SnowflakeObjectKind; name: string; action: string };
      const item = MOCK_OBJECTS[body.kind]?.find((x) => x.name === body.name);
      if (!item) return notFound(`${body.kind} ${body.name}`);
      if (body.action === 'resume') item.state = 'started';
      if (body.action === 'suspend') item.state = 'suspended';
      return HttpResponse.json({ ok: true, message: body.action === 'execute' ? 'Task NIGHTLY_TOTALS is scheduled to run immediately.' : 'Statement executed successfully.' });
    }),
    http.get(`${P}/snowflake/sessions/:sid/context`, ({ params }) => HttpResponse.json(contextOf(String(params.sid)))),
    http.post(`${P}/snowflake/sessions/:sid/use`, async ({ params, request }) => {
      const body = (await request.json()) as { kind: SnowflakeUseKind; name: string };
      const c = contextOf(String(params.sid));
      if (body.kind === 'warehouse' && !MOCK_WAREHOUSES.some((w) => w.name === body.name))
        return HttpResponse.json({ code: '002043', message: `SQL compilation error:\nObject does not exist, or operation cannot be performed.` }, { status: 400 });
      if (body.kind === 'schema') {
        const [db, sc] = body.name.includes('.') ? body.name.split('.', 2) : [c.database, body.name];
        c.database = db;
        c.schema = sc;
      } else c[body.kind] = body.name;
      return HttpResponse.json(c);
    }),
  ];
}

/** SQLite fixture type → Snowflake type. */
function sfType(t: string): string {
  const m = /^([A-Z]+)(\(.*\))?$/.exec(t);
  if (!m) return 'VARCHAR';
  switch (m[1]) {
    case 'INTEGER': return 'NUMBER(38,0)';
    case 'REAL': return 'FLOAT';
    case 'DECIMAL': return `NUMBER${m[2] ?? '(10,2)'}`;
    case 'BOOLEAN': return 'BOOLEAN';
    case 'DATETIME': return 'TIMESTAMP_NTZ(9)';
    case 'BLOB': return 'BINARY';
    case 'JSON': return 'VARIANT';
    default: return 'VARCHAR';
  }
}

export const snowflakePack: MockProviderPack = {
  providers: [snowflakeProvider],
  connections: snowflakeConnections,
  shop: {
    snowflake: {
      schema: 'PUBLIC', schemas: ['ANALYTICS'], databases: ['SHOP'], upperCase: true, type: sfType,
      serverInfo: { version: '9.31.0', productVersion: '9.31.0' },
    },
  },
  extraObjects: { snowflake: SNOWFLAKE_EXTRA_OBJECTS },
  handlers: () => snowflakeHandlers(),
};
