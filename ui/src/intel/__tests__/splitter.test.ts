import { describe, expect, it } from 'vitest';
import { createIntel } from '../index';
import type { Dialect, IntelOptions } from '../types';

let n = 0;
function split(d: Dialect, text: string, opts?: Partial<IntelOptions>) {
  const i = createIntel(d, opts);
  const uri = `split://${++n}`;
  i.setDocument(uri, text);
  return { i, uri, sts: i.statements(uri), texts: i.statements(uri).map((s) => s.text) };
}

describe('splitter: T-SQL', () => {
  const t = (s: string, o?: Partial<IntelOptions>) => split('tsql', s, o).texts;
  it('semicolons', () => expect(t('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']));
  it('statement start on a new line ends the previous statement', () => expect(t('SELECT 1\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']));
  it('statement keyword mid-line does not split', () => expect(t('SELECT 1 SELECT 2')).toEqual(['SELECT 1 SELECT 2']));
  it('blank line splits by default', () => expect(t('SELECT *\nFROM a\n\nSELECT 2')).toEqual(['SELECT *\nFROM a', 'SELECT 2']));
  it('blank line splitting can be turned off', () => expect(t('SELECT a\n\nFROM t', { blankLineSplitsStatements: false })).toEqual(['SELECT a\n\nFROM t']));
  it('blank line inside parentheses does not split', () => expect(t('SELECT (\n\n1)')).toEqual(['SELECT (\n\n1)']));
  it('INSERT ... SELECT on the next line stays together', () => expect(t('INSERT INTO t (a)\nSELECT a FROM s')).toEqual(['INSERT INTO t (a)\nSELECT a FROM s']));
  it('INSERT ... EXEC stays together', () => expect(t('INSERT INTO t\nEXEC p')).toEqual(['INSERT INTO t\nEXEC p']));
  it('INSERT VALUES then SELECT splits', () => expect(t('INSERT INTO t VALUES (1)\nSELECT 1')).toEqual(['INSERT INTO t VALUES (1)', 'SELECT 1']));
  it('UPDATE ... SET on the next line stays together', () => expect(t('UPDATE t\nSET a = 1\nWHERE b = 2')).toEqual(['UPDATE t\nSET a = 1\nWHERE b = 2']));
  it('SET after a complete UPDATE splits', () => expect(t('UPDATE t SET a = 1\nSET NOCOUNT ON')).toEqual(['UPDATE t SET a = 1', 'SET NOCOUNT ON']));
  it('CTE followed by SELECT on the next line stays together', () => expect(t('WITH c AS (SELECT 1 x)\nSELECT * FROM c')).toEqual(['WITH c AS (SELECT 1 x)\nSELECT * FROM c']));
  it('WITH (NOLOCK) hint on a new line does not split', () => expect(t('SELECT * FROM t\nWITH (NOLOCK)')).toEqual(['SELECT * FROM t\nWITH (NOLOCK)']));
  it('UNION ALL then SELECT stays together', () => expect(t('SELECT 1\nUNION ALL\nSELECT 2')).toEqual(['SELECT 1\nUNION ALL\nSELECT 2']));
  it('trailing comma keeps continuation', () => expect(t('SELECT a,\nb FROM t')).toEqual(['SELECT a,\nb FROM t']));
  it('BEGIN ... END block is one statement', () => expect(t('BEGIN\n SELECT 1\n SELECT 2\nEND\nSELECT 3')).toEqual(['BEGIN\n SELECT 1\n SELECT 2\nEND', 'SELECT 3']));
  it('nested BEGIN/END', () => expect(t('BEGIN\n BEGIN\n  SELECT 1;\n END;\n SELECT 2;\nEND\nSELECT 3')).toEqual(['BEGIN\n BEGIN\n  SELECT 1;\n END;\n SELECT 2;\nEND', 'SELECT 3']));
  it('BEGIN TRY / CATCH', () => expect(t('BEGIN TRY\n SELECT 1/0;\nEND TRY\nBEGIN CATCH\n SELECT 2;\nEND CATCH\nSELECT 3')).toEqual(['BEGIN TRY\n SELECT 1/0;\nEND TRY', 'BEGIN CATCH\n SELECT 2;\nEND CATCH', 'SELECT 3']));
  it('BEGIN TRAN is not a block', () => expect(t('BEGIN TRAN\nUPDATE t SET a = 1 WHERE b = 1\nCOMMIT')).toEqual(['BEGIN TRAN', 'UPDATE t SET a = 1 WHERE b = 1', 'COMMIT']));
  it('CASE ... END inside SELECT', () => expect(t("SELECT CASE WHEN a = 1 THEN 'x'\nELSE 'y' END FROM t\nSELECT 2")).toEqual(["SELECT CASE WHEN a = 1 THEN 'x'\nELSE 'y' END FROM t", 'SELECT 2']));
  it('semicolon inside BEGIN/END does not split', () => expect(t('BEGIN SELECT 1; SELECT 2; END')).toEqual(['BEGIN SELECT 1; SELECT 2; END']));
  it('IF with a body on the next line', () => expect(t('IF @x = 1\n  SELECT 1\nSELECT 2')).toEqual(['IF @x = 1\n  SELECT 1', 'SELECT 2']));
  it('IF / ELSE', () => expect(t('IF @x = 1\n  SELECT 1\nELSE\n  SELECT 2\nSELECT 3')).toEqual(['IF @x = 1\n  SELECT 1\nELSE\n  SELECT 2', 'SELECT 3']));
  it('IF ... ; ELSE stays together', () => expect(t('IF @x = 1 SELECT 1; ELSE SELECT 2;')).toEqual(['IF @x = 1 SELECT 1; ELSE SELECT 2']));
  it('ELSE IF chains', () => expect(t('IF @a = 1\n SELECT 1\nELSE IF @a = 2\n SELECT 2\nELSE\n SELECT 3\nPRINT 1')).toEqual(['IF @a = 1\n SELECT 1\nELSE IF @a = 2\n SELECT 2\nELSE\n SELECT 3', 'PRINT 1']));
  it('IF EXISTS (subquery) DROP', () => expect(t('IF EXISTS (SELECT 1 FROM t)\n DROP TABLE t\nCREATE TABLE t (a int)')).toEqual(['IF EXISTS (SELECT 1 FROM t)\n DROP TABLE t', 'CREATE TABLE t (a int)']));
  it('WHILE with BEGIN/END body', () => expect(t('WHILE @i < 10\nBEGIN\n SET @i += 1\nEND\nSELECT @i')).toEqual(['WHILE @i < 10\nBEGIN\n SET @i += 1\nEND', 'SELECT @i']));
  it('CREATE PROCEDURE runs to the end of the batch', () => expect(t('CREATE PROCEDURE p AS\nSELECT 1\n\nSELECT 2\nGO\nSELECT 3')).toEqual(['CREATE PROCEDURE p AS\nSELECT 1\n\nSELECT 2', 'SELECT 3']));
  it('CREATE OR ALTER FUNCTION runs to the end of the batch', () => expect(t('CREATE OR ALTER FUNCTION f() RETURNS int AS\nBEGIN\n RETURN 1\nEND\nGO')).toHaveLength(1));
  it('ALTER VIEW runs to the end of the batch', () => expect(t('ALTER VIEW v AS\nSELECT 1 x\nSELECT 2')).toEqual(['ALTER VIEW v AS\nSELECT 1 x\nSELECT 2']));
  it('CREATE TABLE is a normal statement', () => expect(t('CREATE TABLE t (a int)\nINSERT INTO t VALUES (1)')).toEqual(['CREATE TABLE t (a int)', 'INSERT INTO t VALUES (1)']));
  it('DECLARE CURSOR FOR SELECT stays together', () => expect(t('DECLARE c CURSOR FOR\nSELECT a FROM t\nOPEN c')).toEqual(['DECLARE c CURSOR FOR\nSELECT a FROM t', 'OPEN c']));
  it('GO splits batches', () => {
    const r = split('tsql', 'SELECT 1\nSELECT 2\nGO\nSELECT 3');
    expect(r.sts.map((s) => s.batchIndex)).toEqual([0, 0, 1]);
    expect(r.i.batchesFor(r.uri).map((b) => b.sql)).toEqual(['SELECT 1\nSELECT 2', 'SELECT 3']);
  });
  it('GO 5 repeats the batch', () => {
    const r = split('tsql', 'INSERT INTO t DEFAULT VALUES\nGO 5');
    expect(r.i.batchesFor(r.uri)).toHaveLength(5);
  });
  it('batch positions are 1-based document line/col', () => {
    const r = split('tsql', '\n\n  SELECT 1\nGO\n\n    SELECT 2');
    expect(r.i.batchesFor(r.uri)).toEqual([{ sql: 'SELECT 1', line: 3, col: 3 }, { sql: 'SELECT 2', line: 6, col: 5 }]);
  });
  it('empty batches are skipped', () => {
    const r = split('tsql', 'GO\nGO\nSELECT 1\nGO\n-- only a comment\nGO');
    expect(r.i.batchesFor(r.uri).map((b) => b.sql)).toEqual(['SELECT 1']); // comment-only batches are not sent
  });
  it('GO inside a string does not split', () => expect(t("SELECT 'a\nGO\nb'")).toEqual(["SELECT 'a\nGO\nb'"]));
  it('statement line/col and end positions', () => {
    const r = split('tsql', 'x;\n  SELECT a,\n   b FROM t');
    const s = r.sts[1];
    expect([s.line, s.col, s.endLine, s.endCol]).toEqual([2, 3, 3, 12]);
  });
  it('leading comments are not part of the statement', () => expect(t('-- hello\nSELECT 1')).toEqual(['SELECT 1']));
  it('THROW is a statement start', () => expect(t('SELECT 1;\nTHROW 50000, \'x\', 1')).toEqual(['SELECT 1', "THROW 50000, 'x', 1"]));
  it('MERGE with WHEN clauses is one statement', () => expect(t('MERGE INTO t USING s ON t.id = s.id\nWHEN MATCHED THEN\nUPDATE SET a = 1\nWHEN NOT MATCHED THEN\nINSERT (a) VALUES (1);')).toHaveLength(1));
});

describe('splitter: statementAt', () => {
  it('cursor inside', () => {
    const r = split('tsql', 'SELECT 1;\nSELECT 2;');
    expect(r.i.statementAt(r.uri, 12)!.text).toBe('SELECT 2');
  });
  it('cursor on trailing whitespace / after ; returns the statement', () => {
    const r = split('tsql', 'SELECT 1;   \nSELECT 2');
    expect(r.i.statementAt(r.uri, 11)!.text).toBe('SELECT 1');
  });
  it('cursor on a blank line between statements returns null by default', () => {
    const r = split('tsql', 'SELECT 1\n\n\nSELECT 2');
    expect(r.i.statementAt(r.uri, 10)).toBeNull();
  });
  it('runNextStatementOnBlank picks the next statement', () => {
    const r = split('tsql', 'SELECT 1\n\n\nSELECT 2', { runNextStatementOnBlank: true });
    expect(r.i.statementAt(r.uri, 10)!.text).toBe('SELECT 2');
  });
  it('cursor inside a procedure body returns the whole CREATE', () => {
    const r = split('tsql', 'CREATE PROC p AS\nBEGIN\n SELECT 4\nEND');
    expect(r.i.statementAt(r.uri, 26)!.text.startsWith('CREATE PROC')).toBe(true);
  });
  it('empty document', () => {
    const r = split('tsql', '   ');
    expect(r.i.statementAt(r.uri, 1)).toBeNull();
  });
});

describe('splitter: Oracle', () => {
  const t = (s: string, o?: Partial<IntelOptions>) => split('plsql', s, o).texts;
  it('SQL statements end at ;', () => expect(t('SELECT 1 FROM dual; SELECT 2 FROM dual;')).toEqual(['SELECT 1 FROM dual', 'SELECT 2 FROM dual']));
  it('/ also ends SQL', () => expect(t('SELECT 1 FROM dual\n/\nSELECT 2 FROM dual')).toEqual(['SELECT 1 FROM dual', 'SELECT 2 FROM dual']));
  it('anonymous block ends at /', () => {
    const r = split('plsql', 'DECLARE\n x NUMBER;\nBEGIN\n x := 1;\nEND;\n/\nSELECT 1 FROM dual;');
    expect(r.texts).toEqual(['DECLARE\n x NUMBER;\nBEGIN\n x := 1;\nEND;', 'SELECT 1 FROM dual']);
    expect(r.sts[0].isPlsqlBlock).toBe(true);
    expect(r.sts[0].missingSlash).toBeFalsy();
  });
  it('nested blocks, IF, LOOP and CASE', () => {
    const src = 'BEGIN\n IF a THEN\n  LOOP\n   EXIT;\n  END LOOP;\n END IF;\n CASE x WHEN 1 THEN NULL; END CASE;\n BEGIN NULL; END;\nEND;\n/';
    expect(t(src)).toEqual([src.slice(0, -2)]);
  });
  it('fallback: END; followed by a blank line ends the block (missing /)', () => {
    const r = split('plsql', 'BEGIN\n NULL;\nEND;\n\nSELECT 1 FROM dual;');
    expect(r.texts).toEqual(['BEGIN\n NULL;\nEND;', 'SELECT 1 FROM dual']);
    expect(r.sts[0].missingSlash).toBe(true);
  });
  it('fallback at EOF', () => {
    const r = split('plsql', 'BEGIN\n NULL;\nEND;');
    expect(r.sts[0].missingSlash).toBe(true);
  });
  it('CREATE PROCEDURE is a block ending at /', () => expect(t('CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n NULL;\nEND p;\n/\nSELECT 1 FROM dual;')).toEqual(['CREATE OR REPLACE PROCEDURE p AS\nBEGIN\n NULL;\nEND p;', 'SELECT 1 FROM dual']));
  it('CREATE EDITIONABLE FUNCTION', () => expect(split('plsql', 'CREATE OR REPLACE EDITIONABLE FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END;\n/').sts[0].isPlsqlBlock).toBe(true));
  it('package spec and body', () => {
    const src = 'CREATE PACKAGE pk AS\n PROCEDURE a;\nEND pk;\n/\nCREATE PACKAGE BODY pk AS\n PROCEDURE a IS BEGIN NULL; END;\nEND pk;\n/';
    expect(t(src)).toEqual(['CREATE PACKAGE pk AS\n PROCEDURE a;\nEND pk;', 'CREATE PACKAGE BODY pk AS\n PROCEDURE a IS BEGIN NULL; END;\nEND pk;']);
  });
  it('package body fallback without / waits for the final END', () => {
    expect(t('CREATE PACKAGE BODY pk AS\n PROCEDURE a IS BEGIN NULL; END;\n\n PROCEDURE b IS BEGIN NULL; END;\nEND pk;')).toHaveLength(1);
  });
  it('trigger with DECLARE', () => expect(split('plsql', 'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW\nDECLARE v NUMBER;\nBEGIN :NEW.id := 1; END;\n/').sts).toHaveLength(1));
  it('CREATE TYPE spec ends at ;', () => expect(t('CREATE TYPE pt AS OBJECT (x NUMBER);\n/\nSELECT 1 FROM dual;')).toEqual(['CREATE TYPE pt AS OBJECT (x NUMBER)', 'SELECT 1 FROM dual']));
  it('CREATE VIEW ends at ;', () => expect(t('CREATE VIEW v AS SELECT 1 x FROM dual;\nSELECT 2 FROM dual;')).toEqual(['CREATE VIEW v AS SELECT 1 x FROM dual', 'SELECT 2 FROM dual']));
  it('/ inside a string is not a terminator', () => expect(t("SELECT 'a\n/\nb' FROM dual;")).toEqual(["SELECT 'a\n/\nb' FROM dual"]));
  it("q'[...]' with ; inside", () => expect(t("SELECT q'[a;b]' FROM dual; SELECT 1 FROM dual;")).toEqual(["SELECT q'[a;b]' FROM dual", 'SELECT 1 FROM dual']));
  it('EXEC is rewritten to an anonymous block', () => {
    const r = split('plsql', 'EXEC order_api.create_order(1, 2);\nSELECT 1 FROM dual;');
    expect(r.sts[0].execText).toBe('BEGIN order_api.create_order(1, 2); END;');
    expect(r.i.batchesFor(r.uri)[0].sql).toBe('BEGIN order_api.create_order(1, 2); END;');
  });
  it('EXECUTE without ; ends at end of line', () => {
    const r = split('plsql', 'EXECUTE p\nSELECT 1 FROM dual;');
    expect(r.texts).toEqual(['EXECUTE p', 'SELECT 1 FROM dual']);
    expect(r.sts[0].execText).toBe('BEGIN p; END;');
  });
  it('SQL*Plus commands are recognised and skipped on run', () => {
    const r = split('plsql', 'SET SERVEROUTPUT ON\nSHOW ERRORS\nSPOOL x.log\nSELECT 1 FROM dual;');
    expect(r.sts.slice(0, 3).every((s) => s.skipOnRun && s.kind === 'sqlplus')).toBe(true);
    expect(r.i.batchesFor(r.uri).map((b) => b.sql)).toEqual(['SELECT 1 FROM dual']);
  });
  it('SET TRANSACTION is SQL, not SQL*Plus', () => {
    const r = split('plsql', 'SET TRANSACTION READ ONLY;');
    expect(r.sts[0].skipOnRun).toBeFalsy();
  });
  it('@script is a SQL*Plus command', () => expect(split('plsql', '@setup.sql\nSELECT 1 FROM dual;').sts[0].skipOnRun).toBe(true));
  it('blank line splits SQL statements (SQL Developer style)', () => expect(t('SELECT 1\nFROM dual\n\nSELECT 2 FROM dual')).toEqual(['SELECT 1\nFROM dual', 'SELECT 2 FROM dual']));
  it('blank lines inside a block do not split', () => expect(t('BEGIN\n NULL;\n\n NULL;\nEND;\n/')).toHaveLength(1));
  it('each statement is its own batch', () => {
    const r = split('plsql', 'SELECT 1 FROM dual;\nSELECT 2 FROM dual;');
    expect(r.i.batchesFor(r.uri)).toEqual([{ sql: 'SELECT 1 FROM dual', line: 1, col: 1 }, { sql: 'SELECT 2 FROM dual', line: 2, col: 1 }]);
  });
  it('selection run splits into statements', () => {
    const r = split('plsql', 'xx SELECT 1 FROM dual; SELECT 2 FROM dual; yy');
    expect(r.i.batchesFor(r.uri, [3, 42]).map((b) => [b.sql, b.col])).toEqual([['SELECT 1 FROM dual', 4], ['SELECT 2 FROM dual', 24]]);
  });
});

describe('splitter: SQLite', () => {
  const t = (s: string, o?: Partial<IntelOptions>) => split('sqlite', s, o).texts;
  it('semicolons', () => expect(t('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']));
  it('no split on new-line statement keywords', () => expect(t('SELECT 1\nSELECT 2')).toEqual(['SELECT 1\nSELECT 2']));
  it('blank lines do not split by default', () => expect(t('SELECT 1\n\nFROM t;')).toEqual(['SELECT 1\n\nFROM t']));
  it('blank-line splitting when enabled', () => expect(t('SELECT 1\n\nSELECT 2', { blankLineSplitsStatements: true })).toEqual(['SELECT 1', 'SELECT 2']));
  it('CREATE TRIGGER ... BEGIN ... END; is one statement', () => expect(t('CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n UPDATE x SET a = 1;\n DELETE FROM y;\nEND;\nSELECT 1;')).toEqual(['CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n UPDATE x SET a = 1;\n DELETE FROM y;\nEND', 'SELECT 1']));
  it('CREATE TEMP TRIGGER with CASE inside', () => expect(t("CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 'a' END; END; SELECT 2;")).toHaveLength(2));
  it('BEGIN TRANSACTION is not a block', () => expect(t('BEGIN TRANSACTION; INSERT INTO t VALUES (1); COMMIT;')).toEqual(['BEGIN TRANSACTION', 'INSERT INTO t VALUES (1)', 'COMMIT']));
  it('semicolon inside a string', () => expect(t("SELECT 'a;b'; SELECT 2")).toEqual(["SELECT 'a;b'", 'SELECT 2']));
  it('classify', () => {
    const i = createIntel('sqlite');
    expect(i.classify('UPDATE t SET a = 1')).toBe('update:destructive');
    expect(i.classify('UPDATE t SET a = 1 WHERE b = 2')).toBe('update');
    expect(i.classify('DROP TABLE t')).toBe('drop:destructive');
    expect(i.classify('SELECT 1; DELETE FROM t')).toBe('delete:destructive');
    expect(i.classify('PRAGMA foreign_keys')).toBe('pragma');
    expect(i.classify('WITH x AS (SELECT 1) DELETE FROM t WHERE a IN (SELECT * FROM x)')).toBe('delete');
  });
});

describe('classify (T-SQL / Oracle)', () => {
  const ts = createIntel('tsql'), ora = createIntel('plsql');
  it.each([
    ['SELECT 1', 'select'], ['INSERT INTO t VALUES (1)', 'insert'], ['TRUNCATE TABLE t', 'truncate:destructive'],
    ['UPDATE t SET a = (SELECT 1 WHERE 1 = 1)', 'update:destructive'], ['MERGE INTO t USING s ON 1=1 WHEN MATCHED THEN DELETE;', 'merge'],
    ['EXEC p', 'exec'], ['BEGIN TRAN', 'tx'], ['CREATE TABLE t (a int)', 'create'], ['USE master', 'use'], ['DECLARE @a int', 'declare'],
  ])('tsql %s → %s', (sql, kind) => expect(ts.classify(sql)).toBe(kind));
  it.each([
    ['BEGIN NULL; END;', 'block'], ['DECLARE x NUMBER; BEGIN NULL; END;', 'block'], ['EXEC p', 'exec'], ['DELETE FROM t', 'delete:destructive'],
    ['SET SERVEROUTPUT ON', 'sqlplus'],
  ])('plsql %s → %s', (sql, kind) => expect(ora.classify(sql)).toBe(kind));
});
