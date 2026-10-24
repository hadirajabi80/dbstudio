// MySQL / MariaDB intel (plan-batch3 WP-MY): lexer traits and hook, DELIMITER-aware splitter, statement classification,
// completion / hover / diagnostics against the MySQL shop fixture, codegen type map and the mock pack.
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureDialect } from '../dialect/registry';
import { getSpec } from '../dialect';
import { tokenize } from '../lexer/lexer';
import { createIntel } from '../index';
import { resolveRunTarget } from '../../editor/run-target';
import { resolveType } from '../../codegen/types';
import { mysqlPack } from '../../mocks/packs/mysql';
import { complete, doc, find, intelFor, labels } from './helpers';

beforeAll(async () => {
  await ensureDialect('mysql');
});

const kinds = (sql: string) => tokenize(sql, getSpec('mysql')).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.text}`);
const cols = (items: { kind: string; label: string }[]) => items.filter((x) => x.kind === 'column').map((x) => x.label);

let n = 0;
function split(sql: string, blankLineSplitsStatements = false) {
  const i = createIntel('mysql', { blankLineSplitsStatements });
  const uri = `my://${++n}`;
  i.setDocument(uri, sql);
  return { intel: i, uri, sts: i.statements(uri) };
}
const texts = (sql: string) => split(sql).sts.map((s) => s.text);

describe('MySQL lexer', () => {
  it('backticks, # and -- comments, /*! */ comments', () => {
    expect(kinds('SELECT `order lines`.`qty` # trailing\n-- dash\n/*!40101 SET x = 1 */ FROM `t``x`')).toEqual([
      'keyword:SELECT', 'quotedIdent:`order lines`', 'punct:.', 'quotedIdent:`qty`', 'comment:# trailing', 'comment:-- dash',
      'comment:/*!40101 SET x = 1 */', 'keyword:FROM', 'quotedIdent:`t``x`',
    ]);
  });

  it("strings: backslash escapes, '' doubling, \"…\" strings, N'' / X'' / B'' and _charset introducers", () => {
    expect(kinds(String.raw`SELECT 'it\'s', 'a''b', "say \"hi\"", N'n', X'0A', b'101', _utf8mb4'ü', 0x1F`)).toEqual([
      'keyword:SELECT', String.raw`string:'it\'s'`, 'punct:,', "string:'a''b'", 'punct:,', String.raw`string:"say \"hi\""`, 'punct:,',
      "string:N'n'", 'punct:,', "string:X'0A'", 'punct:,', "string:b'101'", 'punct:,', "string:_utf8mb4'ü'", 'punct:,', 'number:0x1F',
    ]);
    // a backslash before the closing quote does not end the string
    expect(kinds(String.raw`SELECT 'a\\' , 'b'`)).toEqual(['keyword:SELECT', String.raw`string:'a\\'`, 'punct:,', "string:'b'"]);
  });

  it('@user_var, @@sysvar, @@session.x, :name, ? placeholders; := and JSON / null-safe operators', () => {
    expect(kinds("SET @n := @n + 1; SELECT @@version, @@session.sql_mode, j->'$.a', j->>'$.b' FROM t WHERE a <=> :p AND b = ? AND c << 2 && d || e")).toEqual([
      'ident:SET', 'param:@n', 'op::=', 'param:@n', 'op:+', 'number:1', 'punct:;',
      'keyword:SELECT', 'param:@@version', 'punct:,', 'param:@@session', 'punct:.', 'ident:sql_mode', 'punct:,',
      'ident:j', 'op:->', "string:'$.a'", 'punct:,', 'ident:j', 'op:->>', "string:'$.b'", 'keyword:FROM', 'ident:t', 'keyword:WHERE',
      'ident:a', 'op:<=>', 'param::p', 'keyword:AND', 'ident:b', 'op:=', 'param:?', 'keyword:AND', 'ident:c', 'op:<<', 'number:2',
      'op:&&', 'ident:d', 'op:||', 'ident:e',
    ].map((x) => (x === 'ident:SET' ? 'keyword:SET' : x)));
  });

  it('DELIMITER lines are one meta token; $$ and // are single tokens; END$$ splits; \\G is a terminator token', () => {
    expect(kinds('DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\n  delimiter ;\nSELECT 1\\G')).toEqual([
      'meta:DELIMITER $$', 'keyword:CREATE', 'keyword:PROCEDURE', 'ident:p', 'punct:(', 'punct:)', 'ident:BEGIN', 'keyword:SELECT',
      'number:1', 'punct:;', 'keyword:END', 'op:$$', 'meta:delimiter ;', 'keyword:SELECT', 'number:1', 'op:\\G',
    ]);
    expect(kinds('END //')).toEqual(['keyword:END', 'op://']);
    // not a DELIMITER command: not at a line start, or no argument
    expect(kinds('SELECT delimiter FROM t')[1]).toBe('ident:delimiter');
    expect(kinds('delimiter\nFROM t')[0]).toBe('ident:delimiter');
  });

  it('a label colon is not a :name parameter; data types are identifiers', () => {
    expect(kinds('lbl:BEGIN END lbl')).toEqual(['ident:lbl', 'op::', 'ident:BEGIN', 'keyword:END', 'ident:lbl']);
    expect(kinds('CAST(x AS UNSIGNED)')).toEqual(['ident:CAST', 'punct:(', 'ident:x', 'keyword:AS', 'keyword:UNSIGNED', 'punct:)']);
    expect(kinds('id INT')).toEqual(['ident:id', 'ident:INT']);
  });
});

describe('MySQL splitter: DELIMITER', () => {
  it.each([['$$'], ['//'], [';;'], ['|']])('DELIMITER %s: the routine is one statement, the DELIMITER lines are none', (d) => {
    const sql = `DELIMITER ${d}\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND${d}\nSELECT 3${d}\nDELIMITER ;\nSELECT 4;\nSELECT 5`;
    const { sts } = split(sql);
    expect(sts.map((s) => s.text)).toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND', 'SELECT 3', 'SELECT 4', 'SELECT 5']);
    expect(sts.map((s) => s.batchIndex)).toEqual([0, 1, 2, 3]);
    // the statement range covers the custom delimiter (Ctrl+Enter right after `END$$` runs the routine)
    const endOfRoutine = sql.indexOf(`END${d}`) + 3 + d.length;
    expect(sts[0].end).toBe(endOfRoutine);
    expect(sts[0].endLine).toBe(6);
    expect(sts[0].endCol).toBe(4 + d.length);
  });

  it('a delimiter inside strings, comments and backticks does not end the statement', () => {
    expect(texts("DELIMITER $$\nSELECT '$$', `a$$b` /* $$ */ # $$\nFROM t$$\nDELIMITER ;")).toEqual(["SELECT '$$', `a$$b` /* $$ */ # $$\nFROM t"]);
  });

  it('a delimiter glued to a word ends there', () => {
    expect(texts('DELIMITER ;;\nSELECT 1;;SELECT 2;;\nDELIMITER ;')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(texts('DELIMITER GO\nSELECT aGO\nDELIMITER ;')).toEqual(['SELECT a']);
  });

  it('a DELIMITER line ends an unterminated statement; a missing DELIMITER ; keeps the custom one to the end', () => {
    expect(texts('DELIMITER $$\nSELECT 1\nDELIMITER ;\nSELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(texts('DELIMITER $$\nSELECT 1; SELECT 2')).toEqual(['SELECT 1; SELECT 2']);
  });

  it('runs: the DELIMITER lines are never sent, the routine body goes as one batch', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND$$\nDELIMITER ;\nCALL p();';
    const { intel, uri } = split(sql);
    expect(intel.batchesFor(uri).map((b) => [b.sql, b.line])).toEqual([['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND', 2], ['CALL p()', 7]]);
    const afterDelim = sql.indexOf('END$$') + 5;
    expect(resolveRunTarget(intel, uri, 'statement', afterDelim, null)?.batches.map((b) => b.sql)).toEqual(['CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND']);
    expect(resolveRunTarget(intel, uri, 'statement', sql.indexOf('SELECT 1') + 3, null)?.batches[0].sql).toMatch(/^CREATE PROCEDURE/);
    expect(intel.statementAt(uri, 3)).toBeNull(); // on the DELIMITER line
  });
});

describe('MySQL splitter: compound statements without DELIMITER', () => {
  it('CREATE PROCEDURE with DEFINER, IF / WHILE / REPEAT / LOOP / CASE, labels, IF() and REPEAT() functions', () => {
    const body = [
      'CREATE DEFINER=`root`@`%` PROCEDURE p(IN a INT)',
      'BEGIN',
      '  DECLARE x INT DEFAULT 0;',
      '  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN SET x = -1; END;',
      '  IF a > 0 THEN SET x = IF(a > 1, 2, 1); ELSEIF a < 0 THEN SET x = -1; ELSE IF a = 0 THEN SET x = 0; END IF; END IF;',
      '  IF (a > 5) THEN SET x = 5; END IF;',
      '  lbl: WHILE x < 10 DO SET x = x + 1; END WHILE lbl;',
      '  REPEAT SET x = x - 1; UNTIL x = 0 END REPEAT;',
      '  outer_loop: LOOP SET x = x + 1; IF x > 3 THEN LEAVE outer_loop; END IF; END LOOP outer_loop;',
      "  CASE x WHEN 1 THEN SELECT 1; ELSE SELECT REPEAT('a', 3), CASE WHEN x THEN 1 END; END CASE;",
      '  inner_block: BEGIN SELECT 2; END inner_block;',
      'END',
    ].join('\n');
    const { sts } = split(`${body};\nSELECT 1;`);
    expect(sts.map((s) => s.text)).toEqual([body, 'SELECT 1']);
    expect(sts[0].kind).toBe('create');
  });

  it('functions, triggers and events; single-statement routine bodies end at ;', () => {
    const fn = 'CREATE FUNCTION fn_tax(amount DECIMAL(12,2)) RETURNS DECIMAL(12,2)\nDETERMINISTIC\nBEGIN\n  RETURN amount * 0.2;\nEND';
    const trg = 'CREATE TRIGGER trg_orders_check BEFORE INSERT ON orders\nFOR EACH ROW\nBEGIN\n  IF NEW.total < 0 THEN\n    SIGNAL SQLSTATE \'45000\' SET MESSAGE_TEXT = \'negative total\';\n  END IF;\nEND';
    const trg2 = 'CREATE TRIGGER t2 BEFORE UPDATE ON orders FOR EACH ROW IF NEW.total < 0 THEN SET NEW.total = 0; END IF';
    const ev = 'CREATE EVENT ev_purge_notes ON SCHEDULE EVERY 1 DAY DISABLE DO BEGIN DELETE FROM customer_notes WHERE id < 0; END';
    const one = 'CREATE FUNCTION twice(x INT) RETURNS INT DETERMINISTIC RETURN x * 2';
    const alter = 'ALTER EVENT ev_purge_notes DO BEGIN DELETE FROM t; DELETE FROM u; END';
    const agg = 'CREATE OR REPLACE AGGREGATE FUNCTION agg(x INT) RETURNS INT BEGIN DECLARE s INT DEFAULT 0; LOOP FETCH GROUP NEXT ROW; SET s = s + x; END LOOP; RETURN s; END';
    expect(texts([fn, trg, trg2, ev, one, alter, agg, 'SELECT 1'].join(';\n'))).toEqual([fn, trg, trg2, ev, one, alter, agg, 'SELECT 1']);
  });

  it('BEGIN; / BEGIN WORK are transactions, BEGIN NOT ATOMIC / top-level IF are MariaDB blocks', () => {
    const { sts } = split('BEGIN;\nBEGIN WORK;\nINSERT INTO t VALUES (1);\nCOMMIT;\nBEGIN NOT ATOMIC\n  DECLARE x INT;\n  SET x = 1;\nEND;\nIF @a > 0 THEN SELECT 1; ELSE SELECT 2; END IF;\nSTART TRANSACTION');
    expect(sts.map((s) => [s.text.split('\n')[0], s.kind])).toEqual([
      ['BEGIN', 'tx'], ['BEGIN WORK', 'tx'], ['INSERT INTO t VALUES (1)', 'insert'], ['COMMIT', 'tx'], ['BEGIN NOT ATOMIC', 'block'],
      ['IF @a > 0 THEN SELECT 1; ELSE SELECT 2; END IF', 'block'], ['START TRANSACTION', 'tx'],
    ]);
  });

  it('IF NOT EXISTS / IF EXISTS clauses and a column named begin are not blocks', () => {
    expect(texts('CREATE TABLE IF NOT EXISTS t (id INT);\nDROP PROCEDURE IF EXISTS p;\nCREATE PROCEDURE IF NOT EXISTS p() SELECT 1;\nSELECT begin, `end` FROM t;\nSELECT 2')).toEqual([
      'CREATE TABLE IF NOT EXISTS t (id INT)', 'DROP PROCEDURE IF EXISTS p', 'CREATE PROCEDURE IF NOT EXISTS p() SELECT 1', 'SELECT begin, `end` FROM t', 'SELECT 2',
    ]);
  });

  it('\\G / \\g end a statement; a stray $$ after a selected routine too', () => {
    const { sts } = split('SELECT * FROM orders\\G\nSELECT 2\\g SELECT 3;\nCREATE PROCEDURE p() BEGIN SELECT 1; END $$');
    expect(sts.map((s) => s.text)).toEqual(['SELECT * FROM orders', 'SELECT 2', 'SELECT 3', 'CREATE PROCEDURE p() BEGIN SELECT 1; END']);
    expect(sts[0].end).toBe('SELECT * FROM orders\\G'.length);
  });

  it('blank lines split plain statements (when on) but never a routine body', () => {
    const { sts } = split('SELECT 1\n\nSELECT 2;\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n\n  SELECT 2;\nEND;', true);
    expect(sts.map((s) => s.text.split('\n')[0])).toEqual(['SELECT 1', 'SELECT 2', 'CREATE PROCEDURE p()']);
  });
});

describe('MySQL classification (destructive guard)', () => {
  const kind = (sql: string) => intelFor('mysql').classify(sql);
  it.each([
    ['DELETE FROM orders', 'delete:destructive'],
    ['DELETE FROM orders WHERE id = 1', 'delete'],
    ['UPDATE orders SET total = 0', 'update:destructive'],
    ['TRUNCATE TABLE orders', 'truncate:destructive'],
    ['DROP TABLE IF EXISTS orders', 'drop:destructive'],
    ["REPLACE INTO countries (id, name) VALUES (1, 'x')", 'insert'],
    ['INSERT INTO t SET a = 1 ON DUPLICATE KEY UPDATE a = 2', 'insert'],
    ['LOAD DATA INFILE \'/tmp/x.csv\' INTO TABLE t', 'insert'],
    ['START TRANSACTION', 'tx'],
    ['BEGIN', 'tx'],
    ['XA START \'x\'', 'tx'],
    ['CALL get_customer(1)', 'exec'],
    ['SHOW TABLES', 'other'],
    ['DESCRIBE orders', 'explain'],
    ['DESC orders', 'explain'],
    ['EXPLAIN FORMAT=JSON SELECT 1', 'explain'],
    ['USE shop', 'use'],
    ['SET NAMES utf8mb4', 'set'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'select'],
    ['DELIMITER $$\nDROP PROCEDURE p$$\nDELIMITER ;', 'drop:destructive'],
  ])('%s → %s', (sql, k) => {
    expect(kind(sql)).toBe(k);
  });
});

describe('MySQL completion against the shop fixture', () => {
  it('SELECT | FROM customers c → columns first; IF / IFNULL among the functions', () => {
    const r = complete('mysql', 'SELECT | FROM customers c');
    expect(labels(r.items, 4)).toEqual(['id', 'name', 'email', 'country_id']);
    expect(find(r.items, 'IFNULL', (x) => x.kind === 'function')).toBeTruthy();
    expect(find(r.items, 'GROUP_CONCAT', (x) => x.kind === 'function')).toBeTruthy();
  });

  it('FROM | → the databases (shown as schemas) and the shop objects; information_schema below', () => {
    const r = complete('mysql', 'SELECT * FROM |');
    expect(labels(r.items, 2).sort()).toEqual(['archive', 'shop']);
    expect(labels(r.items, 13)).toEqual(expect.arrayContaining(['customers', 'orders', 'order_lines', 'customer_notes', 'extra_types', 'customer_totals']));
    expect(complete('mysql', 'SELECT * FROM archive.|').items.map((x) => x.label)).toEqual(['orders_2020']);
    expect(labels(complete('mysql', 'SELECT * FROM information_schema.|').items)).toEqual(expect.arrayContaining(['TABLES', 'COLUMNS', 'ROUTINES', 'KEY_COLUMN_USAGE']));
    expect(labels(complete('mysql', 'SELECT * FROM performance_schema.|').items)).toEqual(expect.arrayContaining(['threads', 'data_locks', 'error_log']));
    expect(cols(complete('mysql', 'SELECT * FROM information_schema.ROUTINES WHERE |').items)).toEqual(expect.arrayContaining(['ROUTINE_SCHEMA', 'ROUTINE_NAME', 'ROUTINE_TYPE']));
  });

  it('JOIN | → FK join snippets', () => {
    const r = complete('mysql', 'SELECT * FROM customers c JOIN |');
    expect(labels(r.items, 3)).toEqual(expect.arrayContaining(['orders o ON o.customer_id = c.id', 'countries co ON co.id = c.country_id']));
    expect(find(r.items, 'orders o ON o.customer_id = c.id')!.detail).toBe('fk_orders_customers');
  });

  it('backtick quoting: typed backtick prefix, and names that need quoting', () => {
    const r = complete('mysql', 'SELECT * FROM `cust|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['customers', 'customer_notes']));
    const q = complete('mysql', 'SELECT * FROM t JOIN orders o ON o.| ');
    expect(cols(q.items)).toEqual(['id', 'customer_id', 'order_date', 'total', 'status']);
    expect(getSpec('mysql').quote).toEqual(['`', '`']);
  });

  it('CALL | → the procedures (events are procedures with the comment "event"); INSERT INTO t (| skips AUTO_INCREMENT', () => {
    expect(labels(complete('mysql', 'CALL |').items, 4).sort()).toEqual(['add_order_line', 'ev_purge_notes', 'get_customer', 'get_customer_report']);
    expect(cols(complete('mysql', 'INSERT INTO customers (|').items)).toEqual(['name', 'email', 'country_id']);
  });

  it('statement start offers MySQL statements; built-in functions with MariaDB tags', () => {
    const r = complete('mysql', '|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['SELECT', 'REPLACE INTO', 'START TRANSACTION', 'SHOW TABLES', 'DESCRIBE', 'DELIMITER', 'CALL']));
    const f = complete('mysql', 'SELECT json_|').items.map((x) => x.label);
    expect(f).toEqual(expect.arrayContaining(['JSON_EXTRACT', 'JSON_ARRAYAGG', 'JSON_DETAILED']));
    expect(f).not.toContain('JSON_TABLE'); // a table function: FROM only
    const spec = getSpec('mysql');
    expect(spec.functionMap.get('JSON_DETAILED')?.since).toMatch(/^MariaDB/);
    expect(spec.functionMap.get('REGEXP_LIKE')?.since).toBe('MySQL 8.0');
    expect(spec.functionMap.get('NOW')?.kind).toBe('scalar');
    expect(spec.functionMap.get('CURRENT_TIMESTAMP')?.kind).toBe('niladic');
  });

  it('hover on a built-in; no diagnostics for "…" strings, backticks, @vars or routine bodies', () => {
    const i = intelFor('mysql');
    const d = doc(i, [
      'SELECT c.`name`, o.total FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.name = "Bob" AND @x := 1 LIMIT 10, 5;',
      'SELECT IFNULL(email, \'-\') FROM `customers`;',
      'CREATE PROCEDURE p(IN a INT)\nBEGIN\n  DECLARE v INT;\n  SELECT name INTO v FROM customers WHERE id = a;\nEND;',
    ].join('\n'));
    expect(i.softDiagnostics(d.uri)).toEqual([]);
    const h = i.hover(d.uri, d.text.indexOf('IFNULL') + 2);
    expect(h?.markdown).toContain('expr1 unless it is NULL');
  });
});

describe('MySQL codegen types', () => {
  it.each([
    ['int', 'int', 'number'],
    ['int(11)', 'int', 'number'],
    ['bigint', 'long', 'number'],
    ['decimal(12,2)', 'decimal', 'number'],
    ['varchar(100)', 'string', 'string'],
    ["enum('new','paid')", 'string', 'string'],
    ["set('vip','b2b')", 'string', 'string'],
    ['json', 'string', 'unknown'],
    ['datetime', 'DateTime', 'string'],
    ['timestamp(6)', 'DateTime', 'string'],
    ['time(3)', 'TimeSpan', 'string'],
    ['year', 'int', 'number'],
    ['blob', 'byte[]', 'Buffer'],
    ['point', 'byte[]', 'Buffer'],
    ['tinyint', 'sbyte', 'number'],
    ['boolean', 'bool', 'boolean'],
  ])('%s → C# %s / TS %s', (t, cs, ts) => {
    const r = resolveType('mysql', t);
    expect(r.known).toBe(true);
    expect(r.cs).toBe(cs);
    expect(r.ts).toBe(ts);
  });

  it('length / precision come through', () => {
    expect(resolveType('mysql', 'varchar(100)').length).toBe(100);
    expect(resolveType('mysql', 'decimal(12,2)')).toMatchObject({ precision: 12, scale: 2 });
  });
});

describe('MySQL mock pack', () => {
  it('lists MySQL and MariaDB (dialect mysql) with the engine form, and both sample connections', () => {
    expect(mysqlPack.providers.map((p) => [p.id, p.displayName, p.dialect, p.kind])).toEqual([['mysql', 'MySQL', 'mysql', 'relational'], ['mariadb', 'MariaDB', 'mysql', 'relational']]);
    const f = mysqlPack.providers[0].formSpec.fields;
    expect(f.map((x) => x.key)).toEqual(['host', 'port', 'database', 'user', 'password', 'sslMode', 'sslCa', 'allowPublicKeyRetrieval', 'charset', 'connectTimeout', 'compress', 'serverVariables']);
    expect(f.find((x) => x.key === 'sslMode')?.options?.map((o) => o.value)).toEqual(['none', 'preferred', 'required', 'verifyca', 'verifyfull']);
    expect(mysqlPack.connections.map((c) => [c.id, c.providerId, c.folder])).toEqual([['c_mysql', 'mysql', 'Batch 3'], ['c_mariadb', 'mariadb', 'Batch 3']]);
    expect(mysqlPack.extraObjects.mariadb.some((o) => o.t === 'sequence' && o.n === 'order_numbers')).toBe(true);
    expect(mysqlPack.extraObjects.mysql.some((o) => o.t === 'sequence')).toBe(false);
  });
});

describe('MySQL @@ completion and IF() signature help (R3-I1, R3-I2)', () => {
  it('@@ offers the system variables, @ alone does not break', () => {
    const r = complete('mysql', 'SELECT @@ver|');
    expect(labels(r.items)).toEqual(expect.arrayContaining(['@@version', '@@version_comment']));
    expect(complete('mysql', 'SELECT @|').items.length).toBeGreaterThan(0);
  });

  it('IF( in an expression has signature help; a statement-position IF ( does not', () => {
    const i = intelFor('mysql');
    const d = doc(i, 'SELECT IF(a, |');
    const sh = i.signatureHelp(d.uri, d.offset);
    expect(sh?.signatures[0].label).toMatch(/^if\(/i);
    const stmt = doc(i, 'CREATE PROCEDURE p() BEGIN IF (|');
    expect(i.signatureHelp(stmt.uri, stmt.offset)).toBeNull();
  });
});
