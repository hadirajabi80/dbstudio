// MySQL / MariaDB formatter (plan-batch3 WP-MY): the format/rules/mysql.ts tables over the shared layout (SQLite path).
import { beforeAll, describe, expect, it } from 'vitest';
import { formatSql } from '../index';
import { ensureDialect, getSpec } from '../../intel/dialect';
import { tokenize } from '../../intel/lexer/lexer';
import { rulesFor } from '../layout';

beforeAll(async () => {
  await ensureDialect('mysql');
});

const fmt = (sql: string, o = {}) => formatSql(sql, 'mysql', o).text;
/** Token sequence as the formatter's safety check compares it (letter case of words aside). */
const toks = (s: string) => tokenize(s, getSpec('mysql')).filter((t) => t.kind !== 'eof').map((t) => `${t.kind}:${t.kind === 'keyword' || t.kind === 'ident' || t.kind === 'op' ? t.upper : t.text}`);

describe('MySQL formatter', () => {
  it('uses the MySQL tables once the dialect is loaded', () => {
    const r = rulesFor(getSpec('mysql'));
    expect(r.dialect).toBe('mysql');
    expect(r.statementStarts.has('REPLACE')).toBe(true);
    expect(r.functionKeywords.has('IF')).toBe(true);
  });

  it('backtick identifiers are preserved; LIMIT m, n and LIMIT n OFFSET m', () => {
    expect(fmt('select `a b`, c from `order lines` where x = 1 limit 10, 20')).toBe('SELECT\n    `a b`,\n    c\nFROM `order lines`\nWHERE x = 1\nLIMIT 10, 20');
    expect(fmt('select * from t order by a desc limit 10 offset 5')).toBe('SELECT *\nFROM t\nORDER BY a DESC\nLIMIT 10\nOFFSET 5');
  });

  it('STRAIGHT_JOIN is a join; index hints and FOR UPDATE; select modifiers stay on the SELECT line', () => {
    expect(fmt('select * from a straight_join b on a.id = b.id left join c using (id)')).toBe('SELECT *\nFROM a\nSTRAIGHT_JOIN b ON a.id = b.id\nLEFT JOIN c USING (id)');
    expect(fmt('select sql_calc_found_rows distinct a from t force index (ix) where b = 1 for update'))
      .toBe('SELECT SQL_CALC_FOUND_ROWS DISTINCT a\nFROM t FORCE INDEX (ix)\nWHERE b = 1\nFOR UPDATE');
  });

  it('GROUP BY … WITH ROLLUP', () => {
    expect(fmt('select a, count(*) from t group by a with rollup')).toBe('SELECT\n    a,\n    COUNT(*)\nFROM t\nGROUP BY a WITH ROLLUP');
  });

  it('MySQL operators: ->> / -> unspaced, := <=> DIV MOD XOR; IF(), LEFT(), REPLACE() as calls', () => {
    expect(fmt("select j->>'$.a', j -> '$.b', @x := @x + 1, a <=> b, a div 2, a mod 3, a xor b from t"))
      .toBe("SELECT\n    j->>'$.a',\n    j->'$.b',\n    @x := @x + 1,\n    a <=> b,\n    a DIV 2,\n    a MOD 3,\n    a XOR b\nFROM t");
    expect(fmt("select if(a > 1, 'x', 'y'), left(name, 3), replace(name, 'a', 'b') from t"))
      .toBe("SELECT\n    IF(a > 1, 'x', 'y'),\n    LEFT(name, 3),\n    REPLACE(name, 'a', 'b')\nFROM t");
  });

  it('"…" strings, # comments and backslash escapes survive', () => {
    const sql = 'select "it\\"s", \'a\\\'b\' from t # note\nwhere x = 1';
    const out = fmt(sql);
    expect(out).toBe('SELECT\n    "it\\"s",\n    \'a\\\'b\'\nFROM t # note\nWHERE x = 1');
  });

  it('CREATE TABLE with MySQL types and table options keeps every token', () => {
    const sql = "create table t (id int unsigned not null auto_increment, name varchar(100) not null default '' comment 'x', primary key (id), key ix (name)) engine = InnoDB default charset = utf8mb4";
    const out = fmt(sql);
    expect(out.split('\n')[0]).toBe('CREATE TABLE t (');
    expect(out).toContain('\n    id INT UNSIGNED NOT NULL');
    expect(out).toContain('\n    PRIMARY KEY (id),\n    KEY ix (name)\n)');
    expect(toks(out)).toEqual(toks(sql));
  });

  it('INSERT … ON DUPLICATE KEY UPDATE, INSERT … SET and REPLACE INTO keep every token', () => {
    for (const sql of [
      'insert into t (a, b) values (1, 2) on duplicate key update b = values(b), a = a + 1',
      'insert into t set a = 1, b = 2',
      'replace into t (a) values (1)',
      'insert ignore into t (a) select a from u on duplicate key update a = u.a',
      'insert into t (a) values (1) as new on duplicate key update a = new.a',
      "load data local infile '/tmp/x.csv' into table t fields terminated by ',' lines terminated by '\\n' ignore 1 lines",
      'update t1 join t2 on t2.id = t1.id set t1.a = t2.a where t2.b > 0 order by t1.id limit 10',
      'delete t1 from t1 left join t2 on t2.id = t1.id where t2.id is null',
    ]) {
      const r = formatSql(sql, 'mysql');
      expect(r.warnings).toEqual([]);
      expect(toks(r.text)).toEqual(toks(sql));
    }
    expect(fmt('insert into t (a, b) values (1, 2)')).toBe('INSERT INTO t (a, b)\nVALUES (1, 2)');
  });

  it('DELIMITER lines survive untouched at line starts; routine bodies keep every token', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p(IN a INT)\nBEGIN\n  DECLARE x INT DEFAULT 0;\n  IF a > 0 THEN\n    SELECT 1;\n  END IF;\nEND$$\ndelimiter ;\nselect 1;';
    const out = fmt(sql);
    const lines = out.split('\n');
    expect(lines).toContain('DELIMITER $$');
    expect(lines).toContain('delimiter ;');
    expect(toks(out)).toEqual(toks(sql));
    // the splitter still sees the same script after formatting
    expect(toks(fmt(out))).toEqual(toks(sql));
  });

  it('a routine without DELIMITER and a \\G statement keep every token', () => {
    for (const sql of [
      'CREATE PROCEDURE p(IN a INT)\nBEGIN\n  DECLARE x INT DEFAULT 0;\n  IF a > 0 THEN\n    SELECT 1;\n  END IF;\nEND;\nSELECT 2;',
      'select * from t\\G',
    ]) expect(toks(fmt(sql))).toEqual(toks(sql));
  });

  it('DELIMITER lines are chunks of their own and the custom delimiter stays glued to END', () => {
    const sql = 'DELIMITER $$\nCREATE PROCEDURE p(IN a INT)\nBEGIN\n  DECLARE x INT DEFAULT 0;\n  IF a > 0 THEN\n    SELECT 1;\n  END IF;\nEND$$\ndelimiter ;\nselect 1;';
    const r = formatSql(sql, 'mysql');
    expect(r.warnings).toEqual([]);
    expect(r.text).toBe('DELIMITER $$\n\nCREATE PROCEDURE p(IN a INT)\nBEGIN\n  DECLARE x INT DEFAULT 0;\n  IF a > 0 THEN\n    SELECT 1;\n  END IF;\nEND$$\ndelimiter ;\n\nSELECT 1;');
    expect(fmt(r.text)).toBe(r.text); // idempotent
  });

  it('\\G stays with its statement', () => {
    expect(fmt('select 1; select 2\\G select 3')).toBe('SELECT 1;\nSELECT 2 \\G\nSELECT 3');
  });

  it('CREATE PROCEDURE / FUNCTION / TRIGGER / EVENT bodies are kept verbatim', () => {
    for (const sql of [
      'CREATE DEFINER=`root`@`localhost` FUNCTION f(a INT) RETURNS INT DETERMINISTIC BEGIN RETURN a; END;',
      'create trigger trg before insert on t for each row begin set new.a = 1; end',
      'create event ev on schedule every 1 day do delete from t where d < now()',
      'IF @a > 0 THEN SELECT 1; END IF',
    ]) {
      const r = formatSql(sql, 'mysql');
      expect(r.warnings).toEqual([]);
      expect(r.text).toBe(sql);
    }
    // a plain CREATE TABLE / VIEW is still laid out
    expect(fmt('create view v as select a from t')).toContain('\nSELECT a');
  });

  it('ON DUPLICATE KEY UPDATE, INSERT … SET and REPLACE INTO are laid out as clauses', () => {
    expect(fmt('insert into t (a, b) values (1, 2) on duplicate key update b = values(b), a = a + 1'))
      .toBe('INSERT INTO t (a, b)\nVALUES (1, 2)\nON DUPLICATE KEY UPDATE\n    b = VALUES(b),\n    a = a + 1');
    expect(fmt('insert into t set a = 1, b = 2')).toBe('INSERT INTO t\nSET\n    a = 1,\n    b = 2');
    expect(fmt('replace into t (a) values (1)')).toBe('REPLACE INTO t (a)\nVALUES (1)');
    expect(fmt('insert ignore into t (a) select a from u on duplicate key update a = u.a'))
      .toBe('INSERT IGNORE INTO t (a)\nSELECT a\nFROM u\nON DUPLICATE KEY UPDATE a = u.a');
  });

  it('table options and ALTER words are upper-cased', () => {
    expect(fmt("create table t (id int auto_increment, name varchar(10) comment 'x', primary key (id)) engine = InnoDB default charset = utf8mb4 auto_increment = 5"))
      .toBe("CREATE TABLE t (\n    id INT AUTO_INCREMENT,\n    name VARCHAR(10) COMMENT 'x',\n    PRIMARY KEY (id)\n) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 AUTO_INCREMENT = 5");
    expect(fmt('alter table t add column c int after a, modify column b varchar(5) first')).toBe('ALTER TABLE t ADD COLUMN c INT AFTER a, MODIFY COLUMN b VARCHAR(5) FIRST');
  });
});
