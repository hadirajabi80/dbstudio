// Pure designer logic: F4 rewrite, routine templates, table model operations, DDL preview text <-> statements.
import { describe, expect, it } from 'vitest';
import type { TableModel } from '../../api/types';
import { applySummary, scriptToText, splitForApply } from '../ddl';
import { kindsFor, routineSnippet, snippetToText, type WizardSpec } from '../proc/templates';
import { rewriteForEdit, supportsCreateOrAlter } from '../rewrite';
import {
  addColumn, addForeignKey, addIndex, duplicateColumn, moveColumn, newTableModel, removeColumn, sameModel, togglePrimaryKey,
  updateColumn, validateTable, withIds,
} from '../table/model';

describe('rewriteForEdit (F4)', () => {
  it('T-SQL: CREATE → CREATE OR ALTER, keeping comments and body', () => {
    const ddl = '-- report proc\nCREATE PROCEDURE [dbo].[MonthlyReport] @Year int\nAS\nBEGIN\n  CREATE TABLE #t (x int);\n  SELECT 1;\nEND';
    const r = rewriteForEdit(ddl, { dialect: 'tsql', type: 'proc', name: 'MonthlyReport' });
    expect(r.changed).toBe(true);
    expect(r.text).toBe('-- report proc\nCREATE OR ALTER PROCEDURE [dbo].[MonthlyReport] @Year int\nAS\nBEGIN\n  CREATE TABLE #t (x int);\n  SELECT 1;\nEND');
    expect(rewriteForEdit('create view v as select 1 as x', { dialect: 'tsql', type: 'view', name: 'v' }).text).toBe('create OR ALTER view v as select 1 as x');
  });

  it('T-SQL: ALTER on servers older than 2016 SP1, unchanged when already re-runnable', () => {
    expect(supportsCreateOrAlter('13.0.4001.0')).toBe(true);
    expect(supportsCreateOrAlter('13.0.1601.5')).toBe(false);
    expect(supportsCreateOrAlter('12.0.6024.0')).toBe(false);
    expect(supportsCreateOrAlter(null)).toBe(true);
    const r = rewriteForEdit('CREATE FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END', { dialect: 'tsql', type: 'func', name: 'f', productVersion: '12.0.6024.0' });
    expect(r.text).toBe('ALTER FUNCTION dbo.f() RETURNS int AS BEGIN RETURN 1 END');
    expect(rewriteForEdit('CREATE OR ALTER PROC p AS SELECT 1', { dialect: 'tsql', type: 'proc', name: 'p' }).changed).toBe(false);
  });

  it('Oracle: CREATE [EDITIONABLE] → CREATE OR REPLACE for spec and body, with / lines', () => {
    const ddl = 'CREATE EDITIONABLE PACKAGE "SHOP"."ORDER_API" AS\n  PROCEDURE p;\nEND ORDER_API;\nCREATE PACKAGE BODY "SHOP"."ORDER_API" AS\n  PROCEDURE p IS BEGIN NULL; END p;\nEND ORDER_API;';
    const r = rewriteForEdit(ddl, { dialect: 'plsql', type: 'package', name: 'ORDER_API' });
    expect(r.text).toBe(
      'CREATE OR REPLACE EDITIONABLE PACKAGE "SHOP"."ORDER_API" AS\n  PROCEDURE p;\nEND ORDER_API;\n/\nCREATE OR REPLACE PACKAGE BODY "SHOP"."ORDER_API" AS\n  PROCEDURE p IS BEGIN NULL; END p;\nEND ORDER_API;\n/\n',
    );
    expect(rewriteForEdit('CREATE OR REPLACE TRIGGER t BEFORE INSERT ON x BEGIN NULL; END;', { dialect: 'plsql', type: 'trigger', name: 't' }).changed).toBe(false);
  });

  it('SQLite: views and triggers get DROP … IF EXISTS prepended', () => {
    const r = rewriteForEdit('CREATE VIEW customer_totals AS SELECT 1', { dialect: 'sqlite', type: 'view', name: 'customer_totals' });
    expect(r.text).toBe('DROP VIEW IF EXISTS customer_totals;\nCREATE VIEW customer_totals AS SELECT 1;\n');
    const t = rewriteForEdit('CREATE TRIGGER "trg x" AFTER INSERT ON orders BEGIN SELECT 1; END;', { dialect: 'sqlite', type: 'trigger', name: 'trg x', schema: 'archive' });
    expect(t.text.startsWith('DROP TRIGGER IF EXISTS archive."trg x";\n')).toBe(true);
  });
});

const spec = (p: Partial<WizardSpec>): WizardSpec => ({ dialect: 'tsql', kind: 'procedure', schema: 'dbo', name: 'GetOrders', params: [], returns: '', ...p });

describe('procedure wizard templates', () => {
  it('offers the dialect kinds (SQLite: triggers only)', () => {
    expect(kindsFor('sqlite')).toEqual(['trigger']);
    expect(kindsFor('plsql')).toContain('package');
    expect(kindsFor('tsql')).not.toContain('package');
  });

  it('T-SQL procedure with params, OUTPUT and defaults as tab stops', () => {
    const s = routineSnippet(spec({ params: [{ name: 'CustomerId', type: 'int', direction: 'in', default: '' }, { name: '@Total', type: 'decimal(18,2)', direction: 'out', default: '' }] }));
    expect(s).toContain('CREATE OR ALTER PROCEDURE [${1:dbo}].[${2:GetOrders}]');
    expect(s).toContain('    @CustomerId ${3:int},');
    expect(s).toContain('    @Total ${4:decimal(18,2)} OUTPUT');
    expect(snippetToText(s)).toBe('CREATE OR ALTER PROCEDURE [dbo].[GetOrders]\n    @CustomerId int,\n    @Total decimal(18,2) OUTPUT\nAS\nBEGIN\n    SET NOCOUNT ON;\n\n    \nEND\nGO\n');
  });

  it('PL/SQL procedure, function and package', () => {
    const p = snippetToText(routineSnippet(spec({ dialect: 'plsql', schema: 'SHOP', name: 'LOG_EVENT', params: [{ name: 'p_msg', type: 'VARCHAR2', direction: 'in', default: "'x'" }] })));
    expect(p).toBe("CREATE OR REPLACE PROCEDURE SHOP.LOG_EVENT (\n    p_msg IN VARCHAR2 DEFAULT 'x'\n) AS\nBEGIN\n    NULL;\nEND LOG_EVENT;\n/\n");
    const f = snippetToText(routineSnippet(spec({ dialect: 'plsql', kind: 'function', schema: 'SHOP', name: 'TAX', returns: 'NUMBER', params: [] })));
    expect(f).toContain('RETURN NUMBER AS\n    v_result NUMBER;\nBEGIN');
    const pkg = snippetToText(routineSnippet(spec({ dialect: 'plsql', kind: 'package', schema: 'SHOP', name: 'BILLING' })));
    expect(pkg).toContain('CREATE OR REPLACE PACKAGE SHOP.BILLING AS');
    expect(pkg).toContain('CREATE OR REPLACE PACKAGE BODY SHOP.BILLING AS');
    expect(pkg.match(/^\/$/gm)?.length).toBe(2);
  });

  it('PL/SQL package member is appended to spec and body', () => {
    const s = routineSnippet(spec({
      dialect: 'plsql', kind: 'procedure', schema: 'SHOP', name: 'CLOSE_ORDER', params: [{ name: 'p_id', type: 'NUMBER', direction: 'in', default: '' }],
      packageMember: {
        packageName: 'ORDER_API', member: 'procedure',
        spec: 'CREATE EDITIONABLE PACKAGE "SHOP"."ORDER_API" AS\n  PROCEDURE create_order;\nEND ORDER_API;',
        body: 'CREATE PACKAGE BODY "SHOP"."ORDER_API" AS\n  PROCEDURE create_order IS BEGIN NULL; END;\nEND ORDER_API;',
      },
    }));
    const t = snippetToText(s);
    expect(t).toContain('CREATE OR REPLACE PACKAGE "SHOP"."ORDER_API" AS\n  PROCEDURE create_order;\n\n    PROCEDURE CLOSE_ORDER (p_id IN NUMBER);\nEND ORDER_API;\n/');
    expect(t).toContain('    PROCEDURE CLOSE_ORDER (p_id IN NUMBER) IS\n    BEGIN\n        NULL;\n    END CLOSE_ORDER;\nEND ORDER_API;\n/');
    // The existing body's NULL; is not the tab stop: only the new member's body is.
    expect(s).toContain('        ${0:NULL;}');
    expect(s.match(/\$\{0:/g)?.length).toBe(1);
  });

  it('SQLite trigger template', () => {
    const t = snippetToText(routineSnippet(spec({ dialect: 'sqlite', kind: 'trigger', schema: 'main', name: 'trg_orders_ai', trigger: { table: 'orders', timing: 'AFTER', events: ['INSERT'], forEachRow: true } })));
    expect(t).toBe('CREATE TRIGGER trg_orders_ai\nAFTER INSERT ON orders\nFOR EACH ROW\nBEGIN\n    SELECT 1; -- NEW / OLD hold the row values\nEND;\n');
  });

  it('escapes $ and } in literal text', () => {
    const s = routineSnippet(spec({ name: 'Price$Calc', params: [{ name: 'p', type: 'int', direction: 'in', default: "'{x}'" }] }));
    expect(s).toContain('${2:Price\\$Calc}');
    expect(snippetToText(s)).toContain("@p int = '{x}'");
  });
});

describe('table model', () => {
  const base = (): TableModel => newTableModel('tsql', 'dbo', 'Customers');

  it('new tables start with an identity primary key', () => {
    const t = base();
    expect(t.columns[0]).toMatchObject({ name: 'Id', type: 'int', nullable: false, identity: { seed: 1, increment: 1 } });
    expect(t.primaryKey).toEqual({ name: null, columns: ['Id'], clustered: true });
    expect(newTableModel('plsql', 'SHOP').columns[0].name).toBe('ID');
    expect(newTableModel('sqlite', null).columns[0]).toMatchObject({ name: 'id', type: 'INTEGER', identity: null });
  });

  it('add, rename (propagated), move, duplicate and remove columns', () => {
    let t = addColumn(base(), 'tsql');
    expect(t.columns.map((c) => c.name)).toEqual(['Id', 'Column1']);
    t = addIndex(t, 'tsql', ['Column1']);
    t = updateColumn(t, 1, { name: 'Email' }, 'tsql');
    expect(t.indexes[0].columns[0].name).toBe('Email');
    t = updateColumn(t, 0, { name: 'CustomerId' }, 'tsql');
    expect(t.primaryKey!.columns).toEqual(['CustomerId']);
    t = moveColumn(t, 1, -1);
    expect(t.columns.map((c) => c.name)).toEqual(['Email', 'CustomerId']);
    t = duplicateColumn(t, 0, 'tsql');
    expect(t.columns[1]).toMatchObject({ name: 'Email_copy', id: null });
    t = removeColumn(t, 0);
    expect(t.indexes).toEqual([]);
    expect(t.columns.map((c) => c.name)).toEqual(['Email_copy', 'CustomerId']);
  });

  it('primary key toggling keeps order and forces NOT NULL; one identity column', () => {
    let t = addColumn(base(), 'tsql', 1, { name: 'Code', nullable: true });
    t = togglePrimaryKey(t, 1, 'tsql');
    expect(t.primaryKey!.columns).toEqual(['Id', 'Code']);
    expect(t.columns[1].nullable).toBe(false);
    t = togglePrimaryKey(t, 0, 'tsql');
    expect(t.primaryKey!.columns).toEqual(['Code']);
    t = updateColumn(t, 1, { identity: { seed: 1, increment: 1 }, type: 'int' }, 'tsql');
    expect(t.columns.filter((c) => c.identity).map((c) => c.name)).toEqual(['Code']);
  });

  it('validates names, types, identity and foreign keys', () => {
    let t = newTableModel('tsql', 'dbo', '');
    t = addColumn(t, 'tsql', 1, { name: 'Id', type: '' });
    t = addForeignKey(t, 'tsql', { refTable: 'Countries', columns: ['Id'], refColumns: [] });
    const msgs = validateTable(t, 'tsql').map((i) => i.message);
    expect(msgs).toContain('The table needs a name.');
    expect(msgs).toContain('Duplicate column name “Id”.');
    expect(msgs.some((m) => m.includes('needs a type'))).toBe(true);
    expect(msgs.some((m) => m.startsWith('Foreign key'))).toBe(true);
  });

  it('dirty check ignores key order and treats server ids as stable', () => {
    const server = withIds({ ...base(), columns: base().columns.map((c) => ({ ...c, id: undefined })) });
    expect(server.columns[0].id).toBe('Id');
    const reordered = Object.fromEntries(Object.entries(server).reverse()) as unknown as TableModel;
    expect(sameModel(server, reordered)).toBe(true);
    expect(sameModel(server, updateColumn(server, 0, { comment: 'x' }, 'tsql'))).toBe(false);
  });
});

describe('DDL preview text', () => {
  it('T-SQL statements are separated by GO and re-split to the same statements', () => {
    const stmts = [
      { sql: 'ALTER TABLE [dbo].[Customers] ADD [Note] nvarchar(200) NULL', kind: 'alter' as const, warning: null },
      { sql: "EXEC sp_rename 'dbo.Customers.Name', 'FullName', 'COLUMN'", kind: 'rename' as const, warning: 'Renaming breaks code that uses the old name' },
    ];
    const p = scriptToText(stmts, 'tsql');
    expect(p.text).toBe("ALTER TABLE [dbo].[Customers] ADD [Note] nvarchar(200) NULL;\nGO\n\n-- ⚠ Renaming breaks code that uses the old name\nEXEC sp_rename 'dbo.Customers.Name', 'FullName', 'COLUMN';\n");
    expect(p.lines).toEqual([1, 5]);
    expect(splitForApply(p.text, 'tsql').map((s) => s.sql)).toEqual([
      'ALTER TABLE [dbo].[Customers] ADD [Note] nvarchar(200) NULL;',
      "-- ⚠ Renaming breaks code that uses the old name\nEXEC sp_rename 'dbo.Customers.Name', 'FullName', 'COLUMN';",
    ]);
  });

  it('Oracle blocks get a / line; SQLite rebuild keeps trigger bodies intact', () => {
    const o = scriptToText([{ sql: 'COMMENT ON TABLE SHOP.T IS \'x\'', warning: null }, { sql: 'CREATE OR REPLACE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN NULL; END;', warning: null }], 'plsql');
    expect(o.text).toBe("COMMENT ON TABLE SHOP.T IS 'x';\n\nCREATE OR REPLACE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN NULL; END;\n/\n");
    expect(splitForApply(o.text, 'plsql')).toHaveLength(2);
    const sqlite = 'PRAGMA foreign_keys=OFF;\nCREATE TABLE "t__new" (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO "t__new" (id, name) SELECT id, name FROM t;\nDROP TABLE t;\nALTER TABLE "t__new" RENAME TO t;\nCREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET name = upper(name) WHERE id = NEW.id; END;\n';
    const parts = splitForApply(sqlite, 'sqlite');
    expect(parts).toHaveLength(6);
    expect(parts[5].sql).toContain('END');
    expect(parts[5].line).toBe(6);
  });

  it('summarises how the script runs', () => {
    expect(applySummary({ statements: [{ sql: 'x', kind: 'alter', warning: null }], transactional: true, rebuildRequired: false }, 'tsql')).toBe('1 statement · runs in one transaction');
    expect(applySummary({ statements: [], transactional: false, rebuildRequired: false }, 'plsql')).toBe('No changes');
    expect(applySummary({ statements: [{ sql: 'x', kind: 'alter', warning: null }, { sql: 'y', kind: 'alter', warning: null }], transactional: false, rebuildRequired: false }, 'plsql')).toContain('commits on its own');
  });
});
