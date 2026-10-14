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
