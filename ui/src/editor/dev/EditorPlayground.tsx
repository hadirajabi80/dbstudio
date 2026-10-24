// Dev playground (route /#/playground, mounted by the app shell): the SQL editor against the fixture catalogs,
// with a dialect switcher, theme toggle, two editors side by side (multi-instance check) and a run log.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogSnapshot, Dialect, ObjectRef, RunLabel, Settings, SqlBatch } from '../../api/types';
import { Select } from '../../components/common/Select';
import { SqlEditor } from '../SqlEditor';
import type { SqlEditorHandle } from '../SqlEditor.types';
import tsqlShop from '../../intel/__tests__/fixtures/shop-tsql.json';
import plsqlShop from '../../intel/__tests__/fixtures/shop-plsql.json';
import sqliteShop from '../../intel/__tests__/fixtures/shop-sqlite.json';
import pgsqlShop from '../../intel/__tests__/fixtures/shop-pgsql.json';
import mysqlShop from '../../intel/__tests__/fixtures/shop-mysql.json';
import clickhouseShop from '../../intel/__tests__/fixtures/shop-clickhouse.json';
import snowflakeShop from '../../intel/__tests__/fixtures/shop-snowflake.json';
import cqlShop from '../../intel/__tests__/fixtures/shop-cql.json';

const CATALOGS: Record<Dialect, CatalogSnapshot> = {
  tsql: tsqlShop as unknown as CatalogSnapshot,
  plsql: plsqlShop as unknown as CatalogSnapshot,
  sqlite: sqliteShop as unknown as CatalogSnapshot,
  pgsql: pgsqlShop as unknown as CatalogSnapshot,
  // Batch 3 (the WPs replace the samples below with dialect showcases)
  mysql: mysqlShop as unknown as CatalogSnapshot,
  clickhouse: clickhouseShop as unknown as CatalogSnapshot,
  snowflake: snowflakeShop as unknown as CatalogSnapshot,
  cql: cqlShop as unknown as CatalogSnapshot,
};

const SAMPLES: Record<Dialect, string> = {
  tsql: `-- T-SQL playground: try Ctrl+Space, '.', JOIN suggestions, F12 and hover
SELECT c.Name, o.Total
FROM Customers c
JOIN Orders o ON o.CustomerId = c.Id
WHERE o.Total > 100
ORDER BY o.Total DESC;

WITH big AS (SELECT Id, Total AS Amt FROM Orders)
SELECT b. FROM big b

DECLARE @t TABLE (X int, Y nvarchar(10));
SELECT  FROM @t
GO
EXEC GetCustomer @Id = 1
`,
  plsql: `-- PL/SQL playground
SELECT c.name, o.total
  FROM customers c
  JOIN orders o ON o.customer_id = c.id;

DECLARE
  r customers%ROWTYPE;
BEGIN
  SELECT * INTO r FROM customers WHERE id = 1;
  dbms_output.put_line(r.name);
  order_api.create_order(1, 100);
END;
/
`,
  sqlite: `-- SQLite playground
SELECT o.id, o.total, json_extract(o.order_date, '$.x')
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.total > 10
LIMIT 20;

SELECT * FROM archive.orders_2020;
`,
  pgsql: `-- PostgreSQL playground: '.', '::' types, EXCLUDED., joins across sales, hover/F12
SELECT c.name, o.total::numeric(10, 2), o.status
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid'::order_status
LIMIT 20;

INSERT INTO customers AS c (id, name)
VALUES (1, 'x')
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.
RETURNING *;

WITH moved AS (DELETE FROM orders WHERE id = 1 RETURNING *)
SELECT  FROM moved;

SELECT * FROM orders o JOIN sales.invoices i ON 

DO $$
BEGIN
  RAISE NOTICE 'hello; world';
END
$$;
`,
  // WP-MY begin
  mysql: `-- MySQL / MariaDB playground: backticks, # comments, @vars, ->>, LIMIT m, n, DELIMITER blocks, \\G
SELECT c.\`name\`, o.total, o.status # paid / shipped
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status <=> 'paid' AND c.email LIKE '%@example.com'
LIMIT 0, 20;

SET @n := 0;
SELECT @n := @n + 1 AS rn, e.meta->>'$.source' AS source, @@version FROM extra_types e\\G

INSERT INTO countries (id, name) VALUES (99, 'Atlantis')
ON DUPLICATE KEY UPDATE name = VALUES(name);

DELIMITER $$
CREATE PROCEDURE add_note(IN p_customer INT, IN p_note TEXT)
BEGIN
  DECLARE v_count INT DEFAULT 0;
  SELECT COUNT(*) INTO v_count FROM customer_notes WHERE customer_id = p_customer;
  IF v_count < 10 THEN
    INSERT INTO customer_notes (customer_id, lang, note) VALUES (p_customer, 'en', p_note);
  END IF;
END$$
DELIMITER ;

CALL add_note(1, 'hello; world');
`,
  // WP-MY end
  // WP-CH begin
  clickhouse: `-- ClickHouse playground
SELECT c.name, toYYYYMM(o.order_date) AS month, sum(o.total) AS revenue
FROM customers c JOIN orders o FINAL ON o.customer_id = c.id
PREWHERE o.status = 'paid' # hash comment
GROUP BY c.name, month
ORDER BY revenue DESC
LIMIT 3 BY month
SETTINGS max_threads = 4;

CREATE TABLE events (id UInt64, ts DateTime64(3) CODEC(Delta, ZSTD(1)), tags Array(LowCardinality(String)))
ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (id, ts);

SELECT * FROM system.parts WHERE active AND table = {table:String};
`,
  // WP-CH end
  // WP-SF begin
  snowflake: `-- Snowflake playground: VARIANT paths, QUALIFY, LATERAL FLATTEN, $$ bodies
USE WAREHOUSE COMPUTE_WH;
SELECT c.NAME, c.PROFILE:address.city::STRING AS CITY, f.value:sku::STRING AS SKU
FROM CUSTOMERS c, LATERAL FLATTEN(input => c.PROFILE:orders) f
WHERE c.COUNTRY_ID = :country
QUALIFY ROW_NUMBER() OVER (PARTITION BY c.ID ORDER BY f.index DESC) = 1;
EXECUTE IMMEDIATE $$
BEGIN
  RETURN 'ok';
END;
$$;
`,
  // WP-SF end
  // WP-CS begin
  cql: `-- CQL playground (keyspace shop)
USE shop;
CONSISTENCY LOCAL_QUORUM;

SELECT id, name, email, tags, address.city FROM customers WHERE id = 1;

SELECT order_date, order_id, status, total
FROM orders_by_customer
WHERE customer_id = 4 AND order_date >= '2026-03-01'
ORDER BY order_date DESC
LIMIT 10;

SELECT kind, toTimestamp(event_time) AS at, payload FROM shop.events_by_day
WHERE customer_id = 1 AND day = '2026-03-01' AND event_time > maxTimeuuid('2026-03-01 08:00+0000');

INSERT INTO customers (id, name, email, country_id, tags, preferences, created_at, ext_id)
VALUES (6, 'Farid', 'farid@example.com', 1, {'newsletter'}, {'language': 'fa'}, toTimestamp(now()), uuid())
IF NOT EXISTS;

UPDATE customers USING TTL 86400
SET tags = tags + {'vip'}, phones = phones + ['+49 30 7654321']
WHERE id = 6
IF EXISTS;

UPDATE product_views SET views = views + 1 WHERE product_id = 3;

BEGIN BATCH
  INSERT INTO orders (id, customer_id, customer_name, order_date, status, total) VALUES (7, 6, 'Farid', toTimestamp(now()), 'new', 19.50);
  INSERT INTO orders_by_customer (customer_id, order_date, order_id, status, total) VALUES (6, toTimestamp(now()), 7, 'new', 19.50);
  INSERT INTO order_lines (order_id, product_id, product_name, qty, unit_price) VALUES (7, 2, 'Mouse', 1, 19.50);
APPLY BATCH;

SELECT product_id, line_total(qty, unit_price) AS line FROM order_lines WHERE order_id = 1;

DESCRIBE TABLE shop.orders_by_customer;
`,
  // WP-CS end
};

const SETTINGS: Settings['editor'] = {
  fontSize: 14, keywordCase: 'upper', identifierCase: 'asIs', qualifyObjects: 'nonDefaultSchema', qualifyColumns: 'ambiguous',
  tabSize: 4, blankLineSplitsStatements: true,
};

interface LogEntry { at: string; editor: string; label: RunLabel | 'cancel' | 'open'; detail: string }

export function EditorPlayground() {
  const [dialect, setDialect] = useState<Dialect>('tsql');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  const [texts, setTexts] = useState<Record<string, string>>({ a: SAMPLES.tsql, b: 'SELECT * FROM ' });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [cursor, setCursor] = useState('1:1');
  const [twoEditors, setTwoEditors] = useState(true);
  const a = useRef<SqlEditorHandle>(null);
  const catalog = CATALOGS[dialect];
  const add = (e: Omit<LogEntry, 'at'>) => setLog((l) => [{ ...e, at: new Date().toLocaleTimeString() }, ...l].slice(0, 50));
  const onRun = (editor: string) => (label: RunLabel, batches: SqlBatch[]) => add({ editor, label, detail: JSON.stringify(batches, null, 1) });
  const onOpen = (editor: string) => (ref: ObjectRef) => add({ editor, label: 'open', detail: JSON.stringify(ref) });
  const resolvePublicSynonym = useMemo(() => (dialect === 'plsql'
    ? async (name: string) => (name === 'DUAL' ? { t: 'table' as const, n: 'DUAL', c: [['DUMMY', 'VARCHAR2(1)', 1, 0, 0, null] as [string, string, 0 | 1, 0 | 1, number, string | null]] } : null)
    : undefined), [dialect]);

  // Design tokens (ui/src/theme/tokens.css) follow <html data-theme>; the playground drives it from its toggle.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const bg = 'var(--bg-app)';
  const fg = 'var(--fg)';
  const panel = 'var(--bg-panel)';
  const border = 'var(--border)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: bg, color: fg, font: '13px system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 12px', borderBottom: `1px solid ${border}`, flexWrap: 'wrap' }}>
        <strong>Editor playground</strong>
        <label>Dialect{' '}
          <Select<Dialect>
            size="sm"
            style={{ width: 'auto' }}
            value={dialect}
            options={[
              { value: 'tsql', label: 'SQL Server (T-SQL)' }, { value: 'plsql', label: 'Oracle (PL/SQL)' }, { value: 'sqlite', label: 'SQLite' }, { value: 'pgsql', label: 'PostgreSQL' },
              { value: 'mysql', label: 'MySQL / MariaDB' }, { value: 'clickhouse', label: 'ClickHouse' }, { value: 'snowflake', label: 'Snowflake' }, { value: 'cql', label: 'CQL (Cassandra)' },
            ]}
            onChange={(d) => { setDialect(d); setTexts({ a: SAMPLES[d], b: 'SELECT * FROM ' }); }}
          />
        </label>
        <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>Theme: {theme}</button>
        <label><input type="checkbox" checked={twoEditors} onChange={(e) => setTwoEditors(e.target.checked)} /> second editor</label>
        <button onClick={() => { const t = a.current?.getRunTarget('statement'); add({ editor: 'A', label: 'statement', detail: 'getRunTarget: ' + JSON.stringify(t) }); }}>getRunTarget()</button>
        <span style={{ opacity: 0.7 }}>A cursor {cursor} · Ctrl+Enter statement · F5 / Ctrl+Shift+Enter script · Esc cancel · F12 definition</span>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 2, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 2, minHeight: 0, borderBottom: `1px solid ${border}` }}>
            <SqlEditor
              ref={a} tabId={`playground-a-${dialect}`} dialect={dialect} catalog={catalog} value={texts.a}
              onChange={(v) => setTexts((t) => ({ ...t, a: v }))} onRun={onRun('A')} onCancel={() => add({ editor: 'A', label: 'cancel', detail: '' })}
              onOpenObject={onOpen('A')} theme={theme} settings={SETTINGS} usage={usage} onUsageChange={setUsage}
              resolvePublicSynonym={resolvePublicSynonym} onCursorChange={(l, c) => setCursor(`${l}:${c}`)}
              requestServerDiagnostics={async () => []}
            />
          </div>
          {twoEditors && (
            <div style={{ flex: 1, minHeight: 0 }}>
              <SqlEditor
                tabId={`playground-b-${dialect}`} dialect={dialect} catalog={catalog} value={texts.b}
                onChange={(v) => setTexts((t) => ({ ...t, b: v }))} onRun={onRun('B')} onCancel={() => add({ editor: 'B', label: 'cancel', detail: '' })}
                onOpenObject={onOpen('B')} theme={theme} settings={SETTINGS} usage={usage} onUsageChange={setUsage}
              />
            </div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 260, overflow: 'auto', background: panel, borderLeft: `1px solid ${border}`, padding: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Run log</div>
          {log.length === 0 && <div style={{ opacity: 0.6 }}>Nothing run yet.</div>}
          {log.map((e, i) => (
            <div key={i} style={{ borderBottom: `1px solid ${border}`, padding: '4px 0' }}>
              <div><code>{e.at}</code> editor <b>{e.editor}</b> · {e.label}</div>
              {e.detail && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{e.detail}</pre>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default EditorPlayground;
