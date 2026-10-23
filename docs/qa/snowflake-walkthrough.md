# Snowflake walkthrough (plan-batch3 WP-SF)

Goal: the daily loop on Snowflake with the keyboard, and every Snowflake-specific feature once. Run it twice:

1. **Mock**: `npm --prefix ui run dev:mock`, open `http://localhost:5173/?fresh`, connection **Snowflake Shop** (folder
   "Batch 3"). The mock answers the module endpoints (warehouses, roles, objects, session context) with recorded data;
   the catalog is the shared mock shop (schema `main`, see R3-7 in `docs/wp-notes/WP-SF.md`).
2. **Live**: a free trial account (below), the `SHOP` database seeded from `engine/tests/docker/seed-snowflake.sql`, a
   live engine, and a new connection.

## Setting up a free Snowflake trial

1. Go to <https://signup.snowflake.com/>, sign up (no credit card): pick **Standard** edition, any cloud/region close to
   you. The trial gives $400 of credits for 30 days; an X-Small warehouse uses 1 credit per running hour, so this
   walkthrough costs a few cents.
2. The activation mail links to Snowsight. Note the **account identifier** shown under your name → *Connect a tool to
   Snowflake* → *Account identifier* (`ORGNAME-ACCOUNTNAME`), or the URL `https://<identifier>.snowflakecomputing.com`.
   Rowlit accepts either form (and the legacy `xy12345.eu-central-1` locator).
3. In a Snowsight worksheet (role ACCOUNTADMIN or SYSADMIN):
   ```sql
   USE ROLE SYSADMIN;
   CREATE DATABASE IF NOT EXISTS SHOP;
   CREATE WAREHOUSE IF NOT EXISTS COMPUTE_WH WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE;
   USE SCHEMA SHOP.PUBLIC;
   -- paste and run engine/tests/docker/seed-snowflake.sql (Run All)
   ```
4. Optional, key-pair login (recommended for automation; password logins of new accounts require MFA):
   ```bash
   openssl genrsa 2048 | openssl pkcs8 -topk8 -v2 aes256 -inform PEM -out rsa_key.p8   # asks for a passphrase
   openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
   ```
   then `ALTER USER <you> SET RSA_PUBLIC_KEY = '<the base64 body of rsa_key.pub without the BEGIN/END lines>';`
5. Optional, the engine's live tests: set `DBSTUDIO_SF_ACCOUNT`, `DBSTUDIO_SF_USER`, `DBSTUDIO_SF_PASSWORD` (or
   `DBSTUDIO_SF_PRIVATE_KEY_PATH` + `DBSTUDIO_SF_PRIVATE_KEY_PASSPHRASE`), `DBSTUDIO_SF_WAREHOUSE=COMPUTE_WH`,
   `DBSTUDIO_SF_DATABASE=SHOP`, `DBSTUDIO_SF_ROLE=SYSADMIN` and run
   `dotnet test engine/tests/DbStudio.Providers.Snowflake.Tests` (add `DBSTUDIO_SF_SEED=1` to re-seed,
   `DBSTUDIO_UPDATE_GOLDEN=1` to record the live answers to `Fixtures/recorded/live.json.txt`).

Shortcuts are written for Windows; on macOS read Ctrl as ⌘.

| # | Keys | Expected | Command id |
|---|---|---|---|
| 1 | (launch) | Welcome shows a **Snowflake** card ("Snowflake: password, key pair, SSO"). | — |
| 2 | Ctrl+Shift+N, pick Snowflake | Fields: Account, User, Authentication (Password · Key pair (JWT) · Browser SSO · OAuth access token), then only the fields of the chosen method (Password; Private key file + Key passphrase; nothing for SSO; OAuth token), Warehouse, Database, Schema, Role, Host (advanced), Keep session alive, Connect timeout 60, Query tag `Rowlit`. Name suggestion `user@account/database`. *Test connection*: "Snowflake 9.x · ACCOUNT (REGION)". A wrong account answers `270001 … Unable to connect. Check the account identifier…`, a wrong password `390100 … Check user and password`. | `file.newConnection` |
| 3 | Browser SSO | Test opens the IdP login in the default browser; after the login the test succeeds. Opening a console right after does not open the browser again when the account allows ID tokens (`ALTER ACCOUNT SET ALLOW_ID_TOKEN = TRUE`); tokens stay in engine memory only. | `file.newConnection` |
| 4 | Ctrl+Shift+K, Snowflake Shop | Console; status bar "Snowflake"; database pill `SHOP`. Ctrl+Shift+D lists the databases (SHOP, SNOWFLAKE, SNOWFLAKE_SAMPLE_DATA …); choosing another runs `USE DATABASE` on the tab's session (no reconnect). | `connections.change`, `connections.changeDatabase` |
| 5 | Palette → "Snowflake: Session (warehouse, role, database, schema)…" | Session view with four chips for the console's session: changing Warehouse runs `USE WAREHOUSE` (toast), Role `USE ROLE`, Schema `USE SCHEMA SHOP.SALES`; another console keeps its own context. | `snowflake.session` |
| 6 | Alt+1 | Explorer: SHOP → PUBLIC: Tables (COUNTRIES, CUSTOMERS, ORDERS, ORDER_LINES, PRODUCTS), Views (CUSTOMER_ORDERS), Materialized Views, Procedures, Functions, Table Functions, Sequences. No INFORMATION_SCHEMA. Browsing does not resume the warehouse (Query history shows only SHOW / DESCRIBE, warehouse empty). | `view.focusExplorer` |
| 7 | `select * from orders where total > 100;` Ctrl+Enter | Rows; TOTAL is a decimal, ID an integer (NUMBER(38,0)), ORDER_DATE a timestamp. Completion offers ORDERS (upper case), columns after `o.`, and functions with signatures (IFF, DATEADD, FLATTEN). | `run.statement` |
| 8 | `select parse_json('{"a":{"b":[1,2]}}') v, v:a.b[0]::int x, $$a;b$$ s;` | One statement (the `;` in `$$…$$` does not split); `v` is shown as JSON, `x` = 1; no Parameters dialog (`v:a` is a path, not a bind). `where id = :id` does open it. | `run.statement` |
| 9 | `selec 1;` / `select nope from orders;` | `001003 … syntax error line 1 at position 0 unexpected 'selec'` and `000904 … invalid identifier 'NOPE'` at the right line/column; the detail shows the query id. | `run.statement` |
| 10 | `insert into countries values (9, 'Peru');` then `create or replace temporary table t (id int);` | "1 row affected" (no grid with "number of rows inserted"); the DDL prints "Table T successfully created." as a message. | `run.statement` |
| 11 | Manual transaction mode, `update orders set total = total;`, then a DDL | The UPDATE opens the transaction; the DDL commits it (warning "Snowflake commits the open transaction before a DDL statement…"). | `tx.toggleMode` |
| 12 | `select system$wait(60);` Ctrl+Enter, then Cancel | Cancelled within a few seconds; the session stays usable. | `run.cancel` |
| 13 | Script with `BEGIN TRANSACTION; DECLARE … BEGIN FOR … END FOR; RETURN n; END; COMMIT` | The scripting block runs as one statement, BEGIN TRANSACTION / COMMIT as their own. | `run.script` |
| 14 | Ctrl+L on a join | Plan "Snowflake · Estimated": Result → Aggregate → InnerJoin → Filter/TableScan with objects, partitions assigned/total, bytes; Raw = EXPLAIN JSON. Ctrl+Shift+L: the query runs, then the operator statistics: output rows, % of execution time per operator, pruning, spilling warnings, the query id. | `explain.estimated`, `explain.actual` |
| 15 | Object tab of ORDERS | Columns, PK `PK_ORDERS (not enforced)`, clustering key, FKs, referenced by ORDER_LINES; DDL from `GET_DDL`; Dependencies list CUSTOMER_ORDERS (view text) and, with ACCOUNT_USAGE access, objects in other databases. | `objects.open`, `objects.dependencies` |
| 16 | Ctrl+Alt+T | New table designer with Snowflake types (NUMBER, VARCHAR, VARIANT, TIMESTAMP_NTZ …); identity → `IDENTITY(1, 1)`; a *clustered* index becomes `CLUSTER BY (…)`; summary says the DDL is not transactional. Altering a VARCHAR(20) to VARCHAR(10) warns that Snowflake only widens columns. | `designer.newTable` |
| 17 | Palette → "Snowflake: Warehouses" | SHOW WAREHOUSES: state, size, clusters, running/queued, auto-suspend; Resume/Suspend (Suspend asks first; read-only connections disable both). | `snowflake.warehouses` |
| 18 | Palette → "Snowflake: Stages, streams, tasks, pipes…" | Tabs for stages, streams, tasks, pipes, file formats, dynamic tables, alerts; selecting a row shows its DDL (stages: DESCRIBE STAGE settings that differ from the default); tasks offer resume / suspend / execute; *Open in console* copies the DDL. | `snowflake.objects` |
| 19 | Palette → "Snowflake: Query history" | INFORMATION_SCHEMA.QUERY_HISTORY: start, status, duration, bytes scanned, rows, warehouse, user; *Errors only*; a row expands to the full text / error; *Open in console*. Logs tab: Query history, Warehouse load, Login history, Activity (running queries with Kill = SYSTEM$CANCEL_QUERY, open transactions, locks). Without a warehouse the history sources say so. | `snowflake.history`, `logs.showLogs` |
| 20 | Ctrl+Shift+F "alice" with data search | Names/columns/view text found without a warehouse; data search uses the warehouse (`ILIKE :1`). | `search.findInDatabase` |
| 21 | Ctrl+Alt+G on ORDERS | Codegen: C# with Snowflake.Data, TypeScript with snowflake-sdk; VARIANT columns as JSON strings. | `codegen.open` |
| 22 | Format (Shift+Alt+F) a query with `LATERAL FLATTEN(input => v:items)` and `QUALIFY` | Keywords upper-cased, FLATTEN called like a function, paths/casts/binds intact. | `format.document` |

Pass when every row behaves as written in the runs that apply (rows 3, 9–16, 19–20 need the live account).
