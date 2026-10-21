# PostgreSQL keyboard-only walkthrough (PLAN-PG / PLAN-M2 §11)

Goal: the daily loop on PostgreSQL without the mouse, with focus never lost. Run it twice:

1. **Mock**: `npm --prefix ui run dev:mock` (port 5284 when several dev servers run: `npx vite --mode mock --port 5284`),
   open `http://localhost:5284/?fresh`, connection **Postgres Shop** (folder "M2"; `pg-dev`, database `shop`).
2. **Docker**: `docker compose -f engine/tests/docker/compose.yml up -d postgres` (seed `seed-postgres.sql`), a live
   engine, and a new connection to `localhost:5432` / `shop` / user `shop`.

Shortcuts are written for Windows; on macOS read Ctrl as ⌘. Window 1280×800; repeat steps 1–8 at 1024×680. Every step
names the command id (`window.__dbstudio.commands.list()` in a dev build lists them).

| # | Keys | Expected | Command id |
|---|---|---|---|
| 1 | (launch) | Welcome shows a **PostgreSQL** card ("PostgreSQL 12+, Supabase, Neon, RDS") with the PostgreSQL icon and tint. | — |
| 2 | Ctrl+Shift+N, pick PostgreSQL | The form shows Host, Port 5432, Database, User, Password, SSL mode (Prefer), Trust server certificate, Search path, Application name, Connect timeout, Server options. Typing host `pg-dev`, database `shop`, user `shop` suggests the name `shop@pg-dev/shop`. Tab to *Test connection*, Enter: "PostgreSQL 17.2 …". Esc. | `file.newConnection` |
| 3 | Ctrl+Shift+K, type `postgres`, Enter | Console on Postgres Shop; the toolbar shows the database pill `shop`; the status bar says PostgreSQL. | `connections.change` |
| 4 | Ctrl+Shift+D | Database switcher lists analytics / postgres / shop ("Databases" group); choosing `analytics` reopens the session on it (pill updates), back to `shop`. | `connections.changeDatabase` |
| 5 | Alt+1, arrows | Explorer: Postgres Shop → shop → schemas `public` and `sales`; `public` has Tables (customers, orders, …), Views, Materialized Views (customer_totals), Procedures (add_order_line, get_customer_report), Functions (fn_tax ×2), Table Functions (orders_of), Sequences, Types (order_status, email_address), Triggers. No `pg_catalog` / `information_schema`. | `view.focusExplorer` |
| 6 | Alt+2, type `SELECT * FROM orders WHERE status = 'paid' LIMIT 20;`, Ctrl+Enter | 20 rows; `status` is an enum column, `total` numeric. | `run.statement` |
| 7 | `SELECT * FROM nope;` Ctrl+Enter | Error `relation "nope" does not exist` (code 42P01) at the right line; `SELECT nope FROM orders` → `column "nope" does not exist` (42703); `SELEC 1` → `syntax error at or near "SELEC"` (42601). | `run.statement` |
| 8 | `SELECT * FROM orders WHERE customer_id = $1 AND status = :st;` Ctrl+Enter | Parameters dialog lists `$1` (positional) and `:st`; `?` in `doc ? 'tier'` and `x::int` casts are never listed. Values remembered on the next run. | `run.statement` |
| 9 | Alt+3, Ctrl+F, condition `status` *equals* `PAID`, *Apply on server* | Rewritten as `SELECT * FROM (…) AS q WHERE lower(q.status::text) = lower(@fp1)`; a *contains* condition uses `ILIKE … ESCAPE '\'`; a boolean column uses `= TRUE`; `$1` of the original query is kept. | `grid.filter` |
| 10 | Ctrl+Alt+D on `customers` | Data tab pages with `LIMIT 100 OFFSET n`; `tags` (text[]) and `profile` (jsonb) cells are editable as text. | `data.open` |
| 11 | Edit `is_active` (Space), a `tags` cell to `{vip}`, Insert a row, Ctrl+S | Pending changes show `UPDATE customers SET is_active = $1 WHERE id = $2` with `$1 bool true`; the insert is `INSERT INTO customers (…) VALUES ($1, …) RETURNING id`; Enter submits; the new id appears in the grid. | `grid.submitChanges` |
| 12 | Ctrl+L on a SELECT | Plan tab: chip "PostgreSQL · Estimated", tree (Hash Join, Seq Scan public.customers …), hottest node flame, details pane with costs; Raw tab shows indented `EXPLAIN (FORMAT JSON)`. Ctrl+Shift+L asks "Run and explain" for writes, then shows actual rows, Actual Total Time and Shared Hit/Read Blocks. | `explain.estimated`, `explain.actual` |
| 13 | Ctrl+Alt+T | New table designer: key `id bigint`, Identity on (ALWAYS ticked in the properties strip), schema `public`, name placeholder `table_name`. | `designer.newTable` |
| 14 | Add `tags` type `text` + tick **Array**; add `status`, open the type list and pick `order_status` (catalog types are listed next to the built-ins); add a comment; Keys & Indexes → Index on `status`, Include `tags`, WHERE `status <> 'cancelled'` (note "USING btree") | DDL preview: `CREATE TABLE public.… (id bigint GENERATED ALWAYS AS IDENTITY NOT NULL, tags text[], status order_status …, PRIMARY KEY (id))`, `CREATE INDEX … USING btree (status) INCLUDE (tags) WHERE …`, `COMMENT ON …`; summary "runs in one transaction". | `designer.newTable` |
| 15 | Computed expression on a column | The *Stored* box is ticked and disabled (PostgreSQL only has STORED generated columns). Ctrl+S applies. | `designer.apply` |
| 16 | Command palette → "New procedure…", then "New function…", then a trigger | Templates: `CREATE OR REPLACE PROCEDURE public.new_procedure(…) LANGUAGE plpgsql AS $$ … $$;`; function with `RETURNS` / `DECLARE v_result`; trigger = `RETURNS trigger` function + `CREATE OR REPLACE TRIGGER … FOR EACH ROW EXECUTE FUNCTION …_fn();` (FOR EACH ROW toggle, INSERT/UPDATE/DELETE multi-select). Tab walks the placeholders. | `designer.newProcedure`, `designer.newFunction` |
| 17 | F4 on `fn_tax`, `trg_orders_check`, `customer_totals`, `order_status` | Editable script: functions/triggers `CREATE OR REPLACE …` (servers < 14: `DROP TRIGGER IF EXISTS … ON …;` first), the materialized view gets `DROP MATERIALIZED VIEW IF EXISTS …;`, the enum opens unchanged with the hint "ALTER TYPE … ADD VALUE". | `designer.edit` |
| 18 | F4 on a view | View designer shows *WITH CHECK OPTION* (tooltip: CASCADED), no SCHEMABINDING / FORCE; preview `CREATE OR REPLACE VIEW …`. | `designer.edit` |
| 19 | Ctrl+Alt+G on `orders` | Codegen panel: C# (Npgsql `NpgsqlDbType`), Go (database/sql with pgx stdlib, sqlx, **pgx**), TypeScript (node-postgres `$n`, **Prisma schema**), Java, Python (psycopg / SQLAlchemy postgresql types), SQL (MERGE / upsert = `INSERT … ON CONFLICT`, EXEC = `CALL`). `status` is a union of the enum labels in TypeScript. | `codegen.open` |
| 20 | Ctrl+, → Snippets | The dialect filter offers PostgreSQL. | `view.settings` |
| 21 | Ctrl+Alt+Enter in a PostgreSQL console | Multi-run dialog loads the databases of PostgreSQL connections. | `run.multi` |
| 22 | Copy rows as SQL INSERT (grid context menu) | Booleans as `TRUE/FALSE`, bytea as `'\x…'::bytea`, mixed-case columns quoted. | `grid.copyAs.insert` |
| 23 | `DELETE FROM orders` Ctrl+Enter | Destructive guard asks first; `DO $$ BEGIN DELETE FROM orders; END $$` and `$$…$$` strings do not trigger it. | `run.statement` |

Pass when every row behaves as written in both runs, with a visible focus ring after each step.
