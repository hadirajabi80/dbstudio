# Cassandra / ScyllaDB keyboard-only walkthrough (plan-batch3 WP-CS)

Goal: the daily CQL loop (DataStax Studio / DataGrip style) without the mouse, with focus never lost. Run it twice:

1. **Mock**: `npm --prefix ui run dev:mock` (or `npx vite --mode mock --port 5284`), open `http://localhost:5284/?fresh`,
   connection **Cassandra Shop** (folder "Batch 3"; `cassandra-dev`, keyspace `shop`). The mock serves the module endpoints
   (cluster, traces, settings, table info) and answers the cqlsh shell commands; its keyspace is named `main` until the
   mock R3 request (docs/wp-notes/WP-CS-ui.md R3-2) lands.
2. **Docker**: `docker compose -f engine/tests/docker/compose.yml --profile cassandra up -d` (first start ≈ 60–90 s; the
   one-shot `cassandra-seed` runs `seed-cassandra.cql`), a live engine, and a new connection to `localhost:19042`,
   keyspace `shop`. Materialized views and UDFs are disabled in the stock `cassandra:5` image: until the compose R3
   request (docs/wp-notes/WP-CS.md R3-E2) lands, `orders_by_status` and `line_total` are missing (the seed reports two
   errors and carries on) — or start the node as the test fixture does (sed of cassandra.yaml, see CassandraBackend.cs).

Shortcuts are written for Windows; on macOS read Ctrl as ⌘. Window 1280×800; repeat steps 1–10 at 1024×680. Every step
names the command id (`window.__dbstudio.commands.list()` in a dev build lists them).

| # | Keys | Expected | Command id |
|---|---|---|---|
| 1 | (launch) | Welcome shows a **Cassandra** card ("Cassandra 4/5, ScyllaDB") with the Cassandra tint. | — |
| 2 | Ctrl+Shift+N, pick Cassandra | Form: Contact points (required, "localhost, 10.0.0.2"), Port 9042, Local datacenter, Keyspace, User, Password, Use SSL/TLS (then Skip certificate verification, CA certificate), Consistency (LOCAL_QUORUM), Serial consistency (SERIAL), Page size 1000, Connect / Request timeout, Secure connect bundle, Show system keyspaces. Contact points `cassandra-dev`, keyspace `shop` suggest the name `cassandra-dev/shop`. *Test connection*: "Apache Cassandra 5.0.x (CQL 3.4.7)"; a missing keyspace: "Connected, but the keyspace 'x' does not exist." | `file.newConnection` |
| 3 | Ctrl+Shift+K, type `cassandra`, Enter | Console on Cassandra Shop; the toolbar pill says keyspace `shop`; the status bar says CQL. | `connections.change` |
| 4 | Ctrl+Shift+D | Keyspace switcher ("keyspace") lists the user keyspaces (system ones only with *Show system keyspaces*); picking one runs `USE`; back to `shop`. | `connections.changeDatabase` |
| 5 | Alt+1, arrows | Explorer: Cassandra Shop → shop → Tables (countries, customers, events_by_day, order_lines, orders, orders_by_customer, product_views, products), Materialized Views (orders_by_status), Types (address), Functions (line_total). Column tooltips/comments: `customer_id` "partition key", `order_date` "clustering key DESC", `events_by_day.customer_id` "partition key (1 of 2)", key icons on partition and clustering columns. | `view.focusExplorer` |
| 6 | Alt+2, type `SELECT * FROM customers WHERE id = 1;`, Ctrl+Enter | One row; `address` (UDT), `tags` (set), `phones` (list), `preferences` (map) show as JSON; `ext_id` is a uuid, `created_at` a UTC timestamp. Completion: after `FROM ` keyspace/table names, after `WHERE ` columns, `token(`, `writetime(`, `ttl(` with signatures, collection types in CREATE TABLE. | `run.statement` |
| 7 | `SELECT note FROM orders WHERE id = 3;` | Persian text `لطفاً قبل از ارسال تماس بگیرید` renders right-to-left in the cell and the record view. | `run.statement` |
| 8 | `SELEC x;` / `SELECT * FROM nope;` | `SyntaxError` (0x2000) at the right line and column; `Invalid` "table nope does not exist" (0x2200). | `run.statement` |
| 9 | `CONSISTENCY;` `CONSISTENCY ONE;` `SERIAL CONSISTENCY LOCAL_SERIAL;` `PAGING 50;` `SHOW VERSION;` `SHOW HOST;` | Messages "Current consistency level is LOCAL_QUORUM.", "Consistency level set to ONE.", …; SHOW VERSION is a result set (product, release, CQL, protocol). `COPY … TO` answers NOT_SUPPORTED ("use Export/Import"). | `run.script` |
| 10 | Palette → **Cassandra: Console settings…** | Settings tab for this console: consistency / serial consistency / tracing / page size / insert TTL, each applied at once; the values typed in step 9 are shown. | `cassandra.consoleSettings` |
| 11 | Palette → **Cassandra: Toggle tracing**, run `SELECT * FROM orders_by_customer WHERE customer_id = 4;` | A second result set "activity / timestamp / source / source_elapsed_us / thread" and the message "Tracing session: <uuid> — N µs on <node>". | `cassandra.toggleTracing` |
| 12 | Palette → **Cassandra: Show last trace** | Trace tab: header (coordinator, duration, request, consistency, query), a waterfall per node, the event table and the recent traces of the console (↑/↓). `SHOW SESSION <uuid>` in the console prints the same trace. | `cassandra.showLastTrace` |
| 13 | `BEGIN BATCH INSERT …; UPDATE …; APPLY BATCH;` | Runs as one statement (Ctrl+Enter inside the batch picks the whole batch); `UPDATE orders SET note = 'x' WHERE id = 1 IF status = 'nope';` shows `[applied] false` plus the warning "Not applied: …". | `run.statement` |
| 14 | Toolbar transaction toggle → Manual; Ctrl+L on a SELECT | Both answer NOT_SUPPORTED with the explanation ("Cassandra has no multi-statement transactions … BEGIN BATCH … lightweight transactions", "Cassandra has no EXPLAIN. Turn on tracing …"). Typing `BEGIN TRANSACTION;` gives the same message. | `tx.toggleMode`, `explain.estimated` |
| 15 | Ctrl+Alt+D on `orders_by_customer` | Data tab pages by 100 (the engine turns `LIMIT 100 OFFSET n` into driver paging and resumes from the cached paging state, so the next page is one round trip); a sort on a non-key column shows "Cassandra cannot sort across partitions …"; a filter `status = 'paid'` runs with ALLOW FILTERING; "Show only distinct values" on `status` is counted by the engine ("Distinct values counted over N rows"). | `data.open` |
| 16 | Edit `orders.note`, insert a row, delete a row, Ctrl+S | Pending changes show `UPDATE orders SET note = @p1 WHERE id = @p2` (the engine adds `IF EXISTS`, or turns the "verify unchanged" checks into `IF note = …`); a stale value reports "changed by someone else (0 rows)"; an INSERT whose key exists fails with "A row with this primary key already exists"; with an insert TTL set (step 10) inserts get `USING TTL n`. **Needs R3-E1** (grid submit without a transaction): before it lands the submit stops at "Cassandra has no multi-statement transactions". | `grid.submitChanges` |
| 17 | Objects tab (Ctrl+Alt+O) on `shop` | Rows for tables / MV / type / function with estimated partitions and size from `system.size_estimates` (empty until the node has flushed), comment or `PRIMARY KEY (…)` text. | `objects.open` |
| 18 | Object tab of `orders` → Dependencies | Uses: type `address` (column shipping_address); Used by: materialized view `orders_by_status`. On `customers`: index `customers_email_idx` (SAI). On `address`: used by customers, orders. | `objects.dependencies` |
| 19 | Object tab → DDL | Server DESCRIBE text (table + its indexes and views); Cassandra 3.x / old ScyllaDB fall back to the generated DDL. | `objects.dependencies` |
| 20 | Palette → **Cassandra: Table keys & storage…** on `events_by_day` | Partition key (customer_id, day), clustering `event_time DESC`, options (default_time_to_live 90 days), size estimate, DDL with Copy / Open in console. | `cassandra.tableInfo` |
| 21 | Palette → **Cassandra: Show cluster** | Cluster tab: Test Cluster, Apache Cassandra 5.0.x, Murmur3Partitioner, schema agreement, datacenter1 (1/1 up, rack1), node table (address, rack, version, tokens 16, host id, local); Clients tab lists `system_views.clients` (Rowlit's own driver connections). | `cassandra.cluster` |
| 22 | Ctrl+Alt+T | Table designer (keyspace `shop`): types list with collections; mark `tenant`, `day`, `at` as key; add a unique constraint **partition_key** (tenant, day), an index **clustering_order** on `at` DESC, a column comment `static` on `owner`, a check `default_time_to_live` = `86400`. Preview: `CREATE TABLE shop.… (… owner text STATIC, … PRIMARY KEY ((tenant, day), at)) WITH CLUSTERING ORDER BY (at DESC) AND default_time_to_live = 86400`, other indexes `CREATE INDEX IF NOT EXISTS … USING 'sai'`; summary "not transactional". Apply. | `designer.newTable` |
| 23 | F4 on the new table; add a column, change the TTL; then try to change the key | ALTER `ADD`, `WITH default_time_to_live = …`; changing the primary key / a column type / the table name is refused with an explanation. | `designer.edit` |
| 24 | Ctrl+Shift+F, "postal" | Find in database: column `postal_code` of type `address`; "multiply" finds the body of `line_total`; table data is not searched (CQL cannot filter non-key columns without an index). | `search.findInDatabase` |
| 25 | Ctrl+Alt+G on `orders` | Codegen: TypeScript with `cassandra-driver` types; CQL types mapped (uuid → string, timestamp → Date, decimal → BigDecimal-ish types per language). | `codegen.open` |
| 26 | `DROP TABLE it_x;` / `TRUNCATE orders;` | The destructive guard asks first; `BEGIN BATCH … APPLY BATCH` and DESCRIBE/USE/CONSISTENCY do not trigger it. | `run.statement` |

Pass when every row behaves as written in both runs (rows marked with an R3 request after it is applied), with a
visible focus ring after each step.
