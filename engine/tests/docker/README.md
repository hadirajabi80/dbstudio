# Integration-test servers (SQL Server, Oracle)

The SQL Server and Oracle provider tests have two parts:

- **Unit tests** need no server and always run. They cover catalog SQL syntax (ScriptDom), the Oracle owner-bind rule,
  ScriptDom diagnostics positions, connection strings, the bind-variable detector and error mapping.
- **Integration tests** (the shared conformance suite plus provider-specific tests) need a real server. They are
  `[SkippableFact]`s: they are reported as *skipped* when no server is reachable, so `dotnet test` stays green.

## Option 1: Testcontainers (default)

With Docker running, the test fixtures start throw-away containers themselves and seed them from the scripts in
this folder:

```powershell
dotnet test engine/tests/DbStudio.Providers.SqlServer.Tests
dotnet test engine/tests/DbStudio.Providers.Oracle.Tests
```

The first run pulls `mcr.microsoft.com/mssql/server:2022-latest` (~1.5 GB) and `gvenzl/oracle-free:23-slim` (~1 GB).
SQL Server starts in about 15 s, Oracle in about 1–2 min.

## Option 2: long-running servers with docker compose

```powershell
docker compose -f engine/tests/docker/compose.yml up -d
docker compose -f engine/tests/docker/compose.yml ps        # wait until oracle is "healthy"
```

| Server     | Address                    | Credentials                                    |
|------------|----------------------------|------------------------------------------------|
| SQL Server | `localhost,14333`, db `shop` | `sa` / `DbStudio_Dev_2026!` (`MSSQL_SA_PASSWORD`) |
| Oracle     | `localhost:15211/FREEPDB1` | `shop` / `shop` (`APP_USER_PASSWORD`); `SYSTEM` / `DbStudioDev2026` (`ORACLE_PASSWORD`) |

### M2 services (docs/PLAN-M2.md)

All service blocks are in `compose.yml` (written by M2-0); each feature package owns its seed file and appends a
section with its own heading below ("PostgreSQL", "Redis", "MongoDB", "Kafka"). Kafka and the Redis cluster are behind
profiles: `docker compose -f engine/tests/docker/compose.yml --profile kafka --profile cluster up -d`.

| Service | Image | Address (host) | Credentials | Seed (owner) | Env vars for the test backends |
|---|---|---|---|---|---|
| `postgres` | `postgres:17` | `localhost:15432`, db `shop` | `shop` / `shop` (`PG_PASSWORD`) | `seed-postgres.sql` (PG-A) | `DBSTUDIO_PG_HOST`, `DBSTUDIO_PG_PORT`, `DBSTUDIO_PG_PASSWORD` |
| `redis` | `redis/redis-stack:7.4.0-v1` | `localhost:16379` (RedisInsight `:18001`) | none | `seed-redis.sh` via one-shot `redis-seed` (M2-R) | `DBSTUDIO_REDIS_HOST`, `DBSTUDIO_REDIS_PORT`, `DBSTUDIO_REDIS_PASSWORD` |
| `redis-cluster` (+ `-2`, `-3`), profile `cluster` | `bitnami/redis-cluster:7.4` | `localhost:17001-17003`, 3 masters | none | — (M2-R) | `DBSTUDIO_REDIS_CLUSTER` (`host:port,…`) |
| `mongo` | `mongo:7` (replica set `rs0`) | `mongodb://localhost:27018/?directConnection=true` | none | `seed-mongo.js` (M2-M) | `DBSTUDIO_MONGO_URI` |
| `kafka`, profile `kafka` | `apache/kafka:3.8.0` (KRaft) | `localhost:19092` (PLAINTEXT) | none | `seed-kafka.sh` (M2-K) | `DBSTUDIO_KAFKA_BOOTSTRAP` |
| `schema-registry`, profile `kafka` | `confluentinc/cp-schema-registry:7.7.1` | `http://localhost:18081` | none | — (M2-K) | `DBSTUDIO_SCHEMA_REGISTRY_URL` |

The M2 Testcontainers suites follow the `SqlServerBackend` pattern: `DBSTUDIO_IT=0` skips them, the env vars above point
them at these long-running servers, otherwise they start their own container (`Testcontainers.PostgreSql`,
`.Redis`, `.MongoDb`, `.Kafka` 4.16.0). The Redis cluster nodes announce container addresses, so cluster tests only
run inside the compose network or on Linux hosts. The seed files committed by M2-0 are placeholders.

`seed-mssql.sql` is applied by the one-shot `mssql-seed` service; `seed-oracle.sql` runs from
`/container-entrypoint-initdb.d` when the Oracle database is first created. Both scripts are idempotent and can be
re-run (`sqlcmd -i`, or SQL*Plus as SYSTEM/SYS).

Point the tests at these servers instead of Testcontainers with environment variables:

```powershell
$env:DBSTUDIO_MSSQL_SERVER   = "localhost,14333"
$env:DBSTUDIO_MSSQL_PASSWORD = "DbStudio_Dev_2026!"
$env:DBSTUDIO_ORACLE_HOST    = "localhost"
$env:DBSTUDIO_ORACLE_PORT    = "15211"
$env:DBSTUDIO_ORACLE_PASSWORD = "shop"              # password of the SHOP user
$env:DBSTUDIO_ORACLE_SYSTEM_PASSWORD = "DbStudioDev2026"  # optional: re-seed as SYSTEM before the tests
dotnet test engine/tests/DbStudio.Providers.SqlServer.Tests
dotnet test engine/tests/DbStudio.Providers.Oracle.Tests
```

The fixtures re-run the seed scripts (SQL Server as `sa`; Oracle as `SYSTEM` when its password is given) so every
run starts from the same data.

## Disabling integration tests

`DBSTUDIO_IT=0` skips all integration tests without probing Docker (useful on CI agents without Docker).

## Stopping

```powershell
docker compose -f engine/tests/docker/compose.yml down -v
```

## M1.5 endpoints (curl)

The M1.5 provider tests (`*/M15/*`) follow the same rules: SQLite always runs, SQL Server/Oracle skip without a
server. Golden DDL files live in `engine/tests/<project>/M15/golden/`; rewrite them (and the plan fixtures under
`ui/src/mocks/fixtures/m15/`) with `DBSTUDIO_UPDATE_GOLDEN=1 dotnet test` and review the diff.
`engine/tests/smoke/M15/run-smoke-m15.ps1` runs an HTTP smoke test of every M1.5 endpoint on SQLite.

Against a dev engine (`--dev --port 5121 --token dev-token`, `$h` = `-H "Authorization: Bearer dev-token" -H "Content-Type: application/json"`):

```bash
# Sample database + connection profile "Sample: Shop"
curl -s $h -X POST http://127.0.0.1:5121/api/v1/sample-db -d '{}'
# Execute with typed parameters (Oracle :name, SQL Server @name, SQLite :name/@name/$name/?)
curl -s $h -X POST http://127.0.0.1:5121/api/v1/sessions/$SID/execute -d '{"batches":[{"sql":"SELECT * FROM Orders WHERE CustomerId = :c","line":1,"col":1}],"maxRows":100,"stopOnError":true,"label":"statement","params":[{"name":"c","kind":"int","value":5}]}'
# Oracle REF CURSOR out parameter → extra result set
curl -s $h -X POST http://127.0.0.1:5121/api/v1/sessions/$SID/execute -d '{"batches":[{"sql":"BEGIN OPEN :rc FOR SELECT * FROM customers; END;","line":1,"col":1}],"maxRows":100,"stopOnError":true,"label":"statement","params":[{"name":"rc","kind":"refcursor","value":null}]}'
# Describe (SchemaOnly, nothing executes)
curl -s $h -X POST http://127.0.0.1:5121/api/v1/sessions/$SID/describe -d '{"sql":"SELECT Id, Name FROM Customers"}'
# Explain: 202 {executionId}; the plan arrives as the exec.plan WebSocket event
curl -s $h -X POST http://127.0.0.1:5121/api/v1/sessions/$SID/explain -d '{"sql":"SELECT * FROM Orders WHERE Id = 1","mode":"estimated"}'
# Designer
curl -s $h "http://127.0.0.1:5121/api/v1/connections/$CID/designer/types"
curl -s $h "http://127.0.0.1:5121/api/v1/connections/$CID/designer/table?schema=dbo&name=Orders"
curl -s $h -X POST http://127.0.0.1:5121/api/v1/connections/$CID/designer/table/script -d "{\"database\":null,\"original\":$ORIGINAL,\"desired\":$DESIRED}"
curl -s $h -X POST http://127.0.0.1:5121/api/v1/connections/$CID/designer/apply -d '{"database":null,"statements":["ALTER TABLE Orders ADD Note2 TEXT"],"transactional":true}'
# Saved filters and history filters
curl -s $h -X POST http://127.0.0.1:5121/api/v1/filters -d '{"connectionId":"'$CID'","signature":"Id:int","name":"Small ids","model":{"root":{"id":"g","logic":"and","items":[]}}}'
curl -s $h "http://127.0.0.1:5121/api/v1/history?connectionId=$CID&status=ok,error&from=2026-01-01T00:00:00Z&pinned=true"
```

## PostgreSQL (PG-A)

`seed-postgres.sql` builds the shop in `public` plus `sales.invoices` (cross-schema FK), the enum `order_status`, the
domain `email_address`, the sequence `order_numbers`, identity/serial/generated/array/jsonb columns, INCLUDE and partial
indexes, the view `customer_orders`, the materialized view `customer_totals`, the overloads `fn_tax(numeric)` /
`fn_tax(numeric, numeric)`, the table function `orders_of`, the procedures `add_order_line` (INOUT) and
`get_customer_report` (RAISE NOTICE/WARNING) and the trigger `trg_orders_check`. It is idempotent: the test fixture
(`PgBackend`) re-runs it statement by statement on every test run.

```powershell
docker compose -f engine/tests/docker/compose.yml up -d postgres
$env:DBSTUDIO_PG_HOST = "localhost"; $env:DBSTUDIO_PG_PORT = "15432"; $env:DBSTUDIO_PG_PASSWORD = "shop"
dotnet test engine/tests/DbStudio.Providers.PostgreSql.Tests
# without the env vars the suite starts its own postgres:17 container; DBSTUDIO_IT=0 skips it
```

```bash
# connection test (wrong password → message "password authentication failed", detail "SQLSTATE 28P01")
curl -s $h -X POST http://127.0.0.1:5121/api/v1/connections/test -d '{"profile":{"providerId":"postgresql","props":{"host":"localhost","port":15432,"database":"shop","user":"shop","sslMode":"disable"}},"password":"shop"}'
# :name, @name and $n all bind; ? is the jsonb operator, never a placeholder
curl -s $h -X POST http://127.0.0.1:5121/api/v1/sessions/$SID/execute -d '{"batches":[{"sql":"SELECT * FROM extra_types WHERE meta ? '"'"'tier'"'"' AND id = :id","line":1,"col":1}],"maxRows":100,"params":[{"name":"id","kind":"int","value":1}]}'

## Kafka (M2-K)

`docker compose -f engine/tests/docker/compose.yml --profile kafka up -d`, then `bash engine/tests/docker/seed-kafka.sh`
(topics `orders` (3 partitions, 120 JSON messages with keys and headers), `payments-avro`, `events-proto`,
`compacted-users`; Schema Registry subjects `payments-avro-value` (Avro) and `events-proto-value` (Protobuf); groups
`billing` (lag) and `shipping`). Rowlit connection: bootstrap `localhost:19092`, PLAINTEXT, Schema Registry
`http://localhost:18081`.

```powershell
$env:DBSTUDIO_KAFKA_BOOTSTRAP = "localhost:19092"   # else Testcontainers starts apache/kafka:3.8.0
dotnet test engine/tests/DbStudio.Sources.Kafka.Tests
```

Without Docker the suite runs against `KafkaFake` (in-memory broker model) and `FakeSchemaRegistry` (HttpMessageHandler);
the `KafkaIntegrationTests` are skipped.

## Batch 3 services (plan-batch3: MySQL, MariaDB, ClickHouse, Snowflake, Elasticsearch, Cassandra)

WP0 wrote every service block in `compose.yml` and committed the seed files as placeholders; each work package owns its
seed file(s) and appends its own section below this table ("MySQL / MariaDB (WP-MY)", "ClickHouse (WP-CH)",
"Snowflake (WP-SF)", "Elasticsearch (WP-ES)", "Cassandra (WP-CS)"). Elasticsearch and Cassandra are behind profiles:
`docker compose -f engine/tests/docker/compose.yml --profile search --profile cassandra up -d`.

| Service | Image | Address (host) | Credentials | Seed (owner) | Env vars for the test backends |
|---|---|---|---|---|---|
| `mysql` | `mysql:8.4` | `localhost:13306`, db `shop` | `shop` / `shop` (`MYSQL_PASSWORD`; also root's) | `seed-mysql.sql` (WP-MY) | `DBSTUDIO_MYSQL_HOST`, `DBSTUDIO_MYSQL_PORT`, `DBSTUDIO_MYSQL_USER`, `DBSTUDIO_MYSQL_PASSWORD` |
| `mariadb` | `mariadb:11` | `localhost:13307`, db `shop` | `shop` / `shop` (`MARIADB_PASSWORD`) | `seed-mysql.sql` + `seed-mariadb.sql` (WP-MY) | `DBSTUDIO_MARIADB_HOST`, `DBSTUDIO_MARIADB_PORT`, `DBSTUDIO_MARIADB_USER`, `DBSTUDIO_MARIADB_PASSWORD` |
| `clickhouse` | `clickhouse/clickhouse-server:24.8` | `http://localhost:18123` (native `19000`), db `shop` | `shop` / `shop` (`CLICKHOUSE_PASSWORD`) | `seed-clickhouse.sql` (WP-CH) | `DBSTUDIO_CH_HOST`, `DBSTUDIO_CH_PORT`, `DBSTUDIO_CH_USER`, `DBSTUDIO_CH_PASSWORD` |
| `elasticsearch`, profile `search` | `docker.elastic.co/elasticsearch/elasticsearch:8.15.3` | `http://localhost:19200` | none (security off) | `seed-elasticsearch.sh` + `.ndjson` via one-shot `elasticsearch-seed` (WP-ES) | `DBSTUDIO_ES_URL` |
| `cassandra`, profile `cassandra` | `cassandra:5` | `localhost:19042`, keyspace `shop` | none | `seed-cassandra.cql` via one-shot `cassandra-seed` (WP-CS) | `DBSTUDIO_CASSANDRA_HOST`, `DBSTUDIO_CASSANDRA_PORT` |
| — (Snowflake is a cloud service) | — | your test account | password or key pair | `seed-snowflake.sql`, manual or `DBSTUDIO_SF_SEED=1` (WP-SF) | `DBSTUDIO_SF_ACCOUNT`, `DBSTUDIO_SF_USER`, `DBSTUDIO_SF_PASSWORD`, `DBSTUDIO_SF_PRIVATE_KEY_PATH`, `DBSTUDIO_SF_WAREHOUSE`, `DBSTUDIO_SF_DATABASE`, `DBSTUDIO_SF_ROLE` |

The suites follow the M2 pattern: `DBSTUDIO_IT=0` skips them, the env vars point them at these long-running servers,
otherwise they start their own container (`Testcontainers.MySql`, `.MariaDb`, `.ClickHouse`, `.Elasticsearch`,
`.Cassandra` 4.16.0). Snowflake has no container: its unit tests replay recorded fixtures and the live suite runs only
when `DBSTUDIO_SF_ACCOUNT` is set.

### Snowflake (WP-SF)

No container: `DbStudio.Providers.Snowflake.Tests` replays recorded answers (`Fixtures/*.json`, one entry per SQL text or
regex) through `SnowflakeGatewayFake` / `FixtureSqlRunner`. The live suite (shared conformance + `SnowflakeLiveTests`)
runs only with `DBSTUDIO_SF_ACCOUNT` and `DBSTUDIO_SF_DATABASE` set (plus `DBSTUDIO_SF_USER` and `DBSTUDIO_SF_PASSWORD`
or `DBSTUDIO_SF_PRIVATE_KEY_PATH` [+ `DBSTUDIO_SF_PRIVATE_KEY_PASSPHRASE`], `DBSTUDIO_SF_WAREHOUSE`, `DBSTUDIO_SF_ROLE`).
`DBSTUDIO_SF_SEED=1` (re)creates the shop in the database's PUBLIC schema (`seed-snowflake.sql`, the same statements as
`ShopSchema.Seed(Snowflake)`); `DBSTUDIO_UPDATE_GOLDEN=1` writes the live answers of the catalog commands to
`Fixtures/recorded/live.json.txt` to refresh the handwritten fixtures. A free trial account is enough
(`docs/qa/snowflake-walkthrough.md`).
