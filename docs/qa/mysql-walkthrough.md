# MySQL / MariaDB keyboard-only walkthrough (plan-batch3 WP-MY)

Goal: the PostgreSQL walkthrough's daily loop (`pg-walkthrough.md`) on MySQL 8.4 and MariaDB 11, keyboard only, focus
never lost. Run it three times:

1. **Mock**: `npm --prefix ui run dev:mock`, open `http://localhost:5173/?fresh`, connections **MySQL Shop** and
   **MariaDB Shop** (folder "Batch 3"). The mock serves the SQLite shop tables until R3-M1 (docs/wp-notes/WP-MY.md)
   is merged, so types read `INTEGER`/`TEXT` there; everything else below applies.
2. **MySQL**: `docker compose -f engine/tests/docker/compose.yml up -d mysql` (seed `seed-mysql.sql`), a live engine,
   a new connection to `localhost:13306` / database `shop` / user `root` (password `shop`), SSL mode None, *Allow public
   key retrieval* ticked.
3. **MariaDB**: the same with `up -d mariadb` and port `13307` (provider MariaDB).

Shortcuts are written for Windows; on macOS read Ctrl as ⌘. Steps marked *(R3-x)* need the named shared change from
docs/wp-notes/WP-MY.md; until it is merged the step shows the noted behaviour.

| # | Keys | Expected | Command id |
|---|---|---|---|
| 1 | (launch) | Welcome shows **MySQL** ("MySQL 5.7+, 8.x, Aurora, PlanetScale") and **MariaDB** ("MariaDB 10.4+") cards. | — |
| 2 | Ctrl+Shift+N, pick MySQL | Form: Host, Port 3306, Database, User, Password, SSL mode (Preferred; None / Required / Verify CA / Verify full), CA certificate (file), Allow public key retrieval, Character set `utf8mb4`, Connect timeout 15, Compress, Session variables. *Test connection*: "MySQL 8.4.x (MySQL Community Server - GPL)" (MariaDB: "MariaDB 11.x …"). A wrong password: `Access denied for user …` with "Error 1045 SQLSTATE 28000". | `file.newConnection` |
| 3 | Ctrl+Shift+K, `mysql`, Enter | Console on the connection; the toolbar pill shows the **database** `shop`; status bar "MySQL". | `connections.change` |
| 4 | Ctrl+Shift+D | Database switcher (label "database") lists the user databases (no mysql / sys / performance_schema / information_schema); choosing another runs `USE` on the same session (the pill updates), back to `shop`. | `connections.changeDatabase` |
| 5 | Alt+1, arrows | Explorer: connection → `shop` → Tables (countries, customer_notes, customers, extra_types, order_lines, orders, products), Views (customer_orders, customer_totals), Procedures (add_order_line, ev_purge_notes = event, get_customer, get_customer_report), Functions (fn_tax), Triggers (trg_orders_check); MariaDB also Sequences (order_numbers). | `view.focusExplorer` |
| 6 | Alt+2, `SELECT * FROM orders WHERE status = 'paid' LIMIT 20;` Ctrl+Enter | Rows stream into the grid; `status` is text (ENUM), `total` decimal, `order_date` datetime. | `run.statement` |
| 7 | `SELECT * FROM extra_types;` | `u_big` = `18446744073709551615` (text, no precision loss), `flags` = `1010`, `yr` 2026, `tags` `vip,b2b`, `meta` JSON (MariaDB: text), `pos` binary (WKB), `d` `2026-03-04`, `t` `12:34:56.789`. `SELECT note FROM customer_notes` shows the Persian / Arabic / Hebrew rows right-to-left. | `run.statement` |
| 8 | `SELECT * FROM nope;` / `SELECT nmae FROM orders;` / `SELEC 1;` | `Table 'shop.nope' doesn't exist` (1146) with the cursor on `nope`; `Unknown column 'nmae' …` (1054) on `nmae`; syntax error 1064 on the line and column of `SELEC`. | `run.statement` |
| 9 | `SELECT CAST('12abc' AS SIGNED);` | Result 12 plus a server warning "Truncated incorrect INTEGER value: '12abc'" in Messages. `CALL get_customer_report(1)` → two result sets; `CALL get_customer_report(999)` → warning "Customer not found". | `run.statement` |
| 10 | Type the script below, Ctrl+Shift+Enter | The DELIMITER lines are not sent; the procedure is created whole and `CALL p_demo()` returns two result sets. Without DELIMITER (`CREATE PROCEDURE … BEGIN … END;`) Ctrl+Enter inside the body runs the whole routine. | `run.script` |
| 11 | `SELECT SLEEP(60);` Ctrl+Enter, then Esc / Ctrl+Break | Cancelled within a second (KILL QUERY on a side connection); the console stays usable. | `run.cancel` |
| 12 | `CALL add_order_line(5, 2, 3, @ins); SELECT @ins;` | One row `1`; the Parameters dialog does **not** open for `@ins` *(R3-P1; until then it lists `@ins` — leave it empty)*. `SELECT * FROM orders WHERE id = :id` asks for `:id`; `?` works positionally. | `run.statement` |
| 13 | Toolbar: transaction mode Manual; `UPDATE orders SET total = total WHERE id = 1;` | Tx pill turns on. `CREATE TABLE zz (id INT);` → warning "MySQL committed the open transaction implicitly …", the pill turns off. In Auto mode `START TRANSACTION;` turns it on and `ROLLBACK;` off. | `tx.manual` |
| 14 | Ctrl+Alt+D on `customers`, edit a name, add a row, Ctrl+S | `UPDATE customers SET name = @p1 WHERE id = @p2`; the insert's new id comes back *(R3-D1; until then the insert succeeds but the id stays empty and a follow-up error shows)*. | `data.open`, `grid.submitChanges` |
| 15 | Alt+3, Ctrl+F, `name` *contains* `li`, *Apply on server* | `… WHERE lower(name) LIKE CONCAT('%', @fp1, '%') ESCAPE '\\'` returns Alice *(R3-F4; until then the server rejects the predicate — use client-side filtering)*. | `grid.filter` |
| 16 | Ctrl+L on the join `SELECT c.name, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.country_id = 1` | Plan tab "MySQL · Estimated": Query block → Nested loop → `c (fk_customers_countries)` Index lookup, `o (ix_orders_customer)`; costs per node; Raw shows `EXPLAIN FORMAT=JSON`. Ctrl+Shift+L: MySQL `EXPLAIN ANALYZE` tree with actual rows/loops; MariaDB `ANALYZE FORMAT=JSON` with r_rows; the warning "The query ran twice …". | `explain.estimated`, `explain.actual` |
| 17 | Ctrl+Alt+T | Table designer: key `Id int` with auto-increment, type list of MySQL types (tinyint … json, geometry). Add `Note varchar(200)` with a comment, an index on `Note(20)` (prefix), a check `Id > 0`. Preview: one `CREATE TABLE \`shop\`.\`…\` (… AUTO_INCREMENT, … COMMENT '…', PRIMARY KEY …, INDEX … (\`Note\`(20)), CONSTRAINT … CHECK …)`; the summary warns that MySQL DDL is not transactional. Ctrl+S applies. | `designer.newTable` |
| 18 | F4 on `orders`, rename `total` → `amount`, move `status` up, drop the FK | Preview: `ALTER TABLE … DROP FOREIGN KEY …;` then `ALTER TABLE … CHANGE COLUMN \`total\` \`amount\` decimal(12,2) NOT NULL, MODIFY COLUMN \`status\` … AFTER …`. FULLTEXT index `ft_products_name` on products is shown in the object tab but never dropped by the designer. | `designer.edit` |
| 19 | F4 on `customer_orders` | View designer: `CREATE OR REPLACE VIEW`, *WITH CHECK OPTION* (CASCADED); renaming emits `RENAME TABLE`. | `designer.edit` |
| 20 | Palette → "New procedure…" / "New function…" / trigger | `CREATE PROCEDURE … BEGIN … END;` templates *(R3-T1; until then MySQL gets the SQLite trigger template — edit it by hand)*. Saving runs the CREATE through the console; a taken name is refused. | `designer.newProcedure` |
| 21 | Enter on `get_customer_report` / `trg_orders_check` / `ev_purge_notes` | Object tab: parameters (`IN p_id int`), DDL from `SHOW CREATE …` (runs as one statement from the console), Dependencies: uses `customers`, `orders`; customers is *used by* the view, the procedures and (FK) orders; orders shows the trigger. | `object.open` |
| 22 | Objects tab on `shop` | Rows, size (data + index), created / modified per table; procedures, functions, events ("event (disabled): …") and triggers listed. | `objects.open` |
| 23 | Ctrl+Shift+F `customer`, then *Data* `تهران` | Names (tables, view, procedures), columns (`customer_id` …), code (procedure bodies); data finds the Persian note in `customer_notes.note`; regex `^ali` finds Alice (works on MySQL and MariaDB). | `search.open` |
| 24 | Logs tab | Sources: Error log (MySQL 8.0.22+; MariaDB: unavailable "error log file only"), General / Slow query log (unavailable unless log_output has TABLE, with the `SET GLOBAL …` hint), InnoDB status (one entry per section, deadlocks highlighted), Activity (processlist; Kill / Cancel = `KILL` / `KILL QUERY`, lock waits). A user without PROCESS sees the exact `GRANT PROCESS ON *.* TO …`. | `logs.open` |
| 25 | Ctrl+Alt+G on `orders` | Codegen: C# with MySqlConnector, TypeScript with mysql2; `total` decimal, `status` string, `order_date` DateTime. | `codegen.open` |
| 26 | ER diagram of `shop` | customers → countries, orders → customers, order_lines → orders / products, customer_notes → customers. | `er.open` |
| 27 | `DELETE FROM orders` Ctrl+Enter | Destructive guard asks first; a `DELETE` inside a procedure body does not trigger it when only creating the procedure. | `run.statement` |

Script for step 10:

```sql
DELIMITER $$
CREATE PROCEDURE p_demo()
BEGIN
  IF (SELECT COUNT(*) FROM orders) > 0 THEN
    SELECT 'has orders' AS info;
  END IF;
  SELECT COUNT(*) AS n FROM customers;
END$$
DELIMITER ;
CALL p_demo();
DROP PROCEDURE p_demo;
```

Pass when every row behaves as written (or as noted for a pending R3 change) in all three runs, with a visible focus
ring after each step.
