// Table designer UX rules (QA design-18, features-18, features-19, features-13): validation timing, the default key's
// clustered flag per dialect, the properties strip following a new column, and the designer tab key; Insert appends
// (design-r1-03), the view designer's "No changes" state (features-r1-03) and the rebuild confirmation (design-r1-04).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DdlStatement, DesignerType, Dialect, TableModel, ViewOptions } from '../../api/types';
import { ConfirmDialog, confirmItemList } from '../../components/common/ConfirmDialog';
import { useCatalog, type ConnCatalog } from '../../store/catalog';
import { useUi } from '../../store/ui';
import { designerKey } from '../open';
import { NO_VIEW_OPTIONS, viewDirty, viewUnchanged } from '../view/viewState';
import { ColumnGrid } from './ColumnGrid';
import { confirmItems, recreatedSummary } from './confirmSummary';
import { addColumn, defaultPkClustered, duplicateColumn, newTableModel, togglePrimaryKey, updateColumn, validateTable, visibleIssues } from './model';

describe('validation timing (design-18)', () => {
  const fresh = (d: Dialect = 'tsql') => validateTable(newTableModel(d, 'dbo'), d);

  it('a pristine new table shows no "needs a name" error', () => {
    const issues = fresh();
    expect(issues.map((i) => i.message)).toContain('The table needs a name.');
    expect(visibleIssues(issues, { existing: false, nameTouched: false, applyTried: false })).toEqual([]);
  });

  it('shows it once the Name field was left, or after Apply', () => {
    const issues = fresh();
    expect(visibleIssues(issues, { existing: false, nameTouched: true, applyTried: false }).map((i) => i.field)).toEqual(['name']);
    expect(visibleIssues(issues, { existing: false, nameTouched: false, applyTried: true })).toHaveLength(1);
  });

  it('column problems come from the user\'s own edits and show right away', () => {
    let t = newTableModel('tsql', 'dbo');
    t = updateColumn(t, 0, { name: '' }, 'tsql');
    const shown = visibleIssues(validateTable(t, 'tsql'), { existing: false, nameTouched: false, applyTried: false });
    expect(shown.some((i) => i.column === 0)).toBe(true);
    expect(shown.some((i) => i.field === 'name')).toBe(false);
  });

  it('an existing table shows everything', () => {
    const t = { ...newTableModel('tsql', 'dbo', 'Orders'), name: '' };
    expect(visibleIssues(validateTable(t, 'tsql'), { existing: true, nameTouched: false, applyTried: false })).toHaveLength(1);
  });
});

describe('default primary key clustered flag (features-19)', () => {
  // The engine reads every SQLite / Oracle key as clustered: true and warns "SQLite ignores clustered/included-column
  // index options" for a key with clustered: false (SqliteDdlScripter.CollectModelWarnings), so a new key must match.
  it('matches what the engine reads back per dialect', () => {
    expect(newTableModel('sqlite', 'main').primaryKey?.clustered).toBe(true);
    expect(newTableModel('plsql', 'SHOP').primaryKey?.clustered).toBe(true);
    expect(newTableModel('tsql', 'dbo').primaryKey?.clustered).toBe(true);
  });

  it('SQL Server clusters a new key only while no index is clustered', () => {
    const t = newTableModel('tsql', 'dbo', 'T');
    const withClustered: TableModel = { ...t, indexes: [{ name: 'IX', columns: [{ name: 'Id', desc: false }], unique: false, clustered: true, include: [], filter: null }] };
    expect(defaultPkClustered('tsql', withClustered)).toBe(false);
    expect(defaultPkClustered('sqlite', withClustered)).toBe(true);
  });

  it('a key re-created on SQLite keeps clustered: true', () => {
    let t = newTableModel('sqlite', 'main', 'Notes');
    t = togglePrimaryKey(t, 0, 'sqlite'); // remove
    expect(t.primaryKey).toBeNull();
    t = togglePrimaryKey(t, 0, 'sqlite'); // add again
    expect(t.primaryKey?.clustered).toBe(true);
  });
});

describe('properties strip follows new columns (features-18)', () => {
  const TYPES: DesignerType[] = ['int', 'nvarchar(100)'].map((x) => ({ name: x.replace(/\(.*/, ''), default: x, params: 'none', category: 'other' }));
  let active = -1;
  let latest: TableModel;

  /** Mirrors TableDesigner: onAdd / onDuplicate also move the active column to the new one. */
  function Harness() {
    const [t, setT] = useState<TableModel>(() => addColumn(newTableModel('tsql', 'dbo', 'Orders'), 'tsql', 1, { name: 'Name', type: 'nvarchar(100)' }));
    const [act, setAct] = useState(0);
    active = act;
    latest = t;
    return (
      <ColumnGrid
        table={t} dialect="tsql" types={TYPES} features={null} readOnly={false} errorRows={new Set()} active={act}
        onActiveChange={setAct}
        onChange={(i, p) => setT((x) => updateColumn(x, i, p, 'tsql'))}
        onTogglePk={(i) => setT((x) => togglePrimaryKey(x, i, 'tsql'))}
        onAdd={(at) => {
          setT((x) => addColumn(x, 'tsql', at));
          setAct(Math.max(0, Math.min(at, t.columns.length)));
        }}
        onRemove={() => undefined}
        onMove={() => undefined}
        onDuplicate={(i) => {
          setT((x) => duplicateColumn(x, i, 'tsql'));
          setAct(i + 1);
        }}
      />
    );
  }
  const cell = (row: number, col: number) => document.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`)!;

  it('Insert and the add row make the new column active', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(0, 0).focus();
    await user.keyboard('{Insert}');
    expect(latest.columns).toHaveLength(3);
    expect(active).toBe(2); // appended at the end (design-r1-03)
    await user.keyboard('{Escape}');
    cell(3, 0).focus(); // the "add column" row
    await user.keyboard('{Enter}');
    expect(latest.columns).toHaveLength(4);
    expect(active).toBe(3);
  });

  it('Insert appends at the end from any row; Alt+Insert inserts below the current row (design-r1-03)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(0, 0).focus(); // right after opening, the cursor is on the first column
    await user.keyboard('{Insert}');
    await user.keyboard('{Control>}a{/Control}Notes{Enter}');
    expect(latest.columns.map((c) => c.name)).toEqual(['Id', 'Name', 'Notes']);
    expect(active).toBe(2);
    cell(0, 0).focus();
    await user.keyboard('{Alt>}{Insert}{/Alt}');
    expect(active).toBe(1);
    await user.keyboard('{Control>}a{/Control}Code{Enter}');
    expect(latest.columns.map((c) => c.name)).toEqual(['Id', 'Code', 'Name', 'Notes']);
    // on the add row, Alt+Insert appends as well
    cell(4, 0).focus();
    await user.keyboard('{Alt>}{Insert}{/Alt}');
    expect(latest.columns).toHaveLength(5);
    expect(active).toBe(4);
    expect(cell(5, 0).textContent).toBe('Add column (Enter or Insert) · Alt+Insert inserts below');
  });

  it('Ctrl+D makes the copy active', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    cell(1, 0).focus();
    await user.keyboard('{Control>}d{/Control}');
    expect(latest.columns.map((c) => c.name)).toEqual(['Id', 'Name', 'Name_copy']);
    expect(active).toBe(2);
  });
});

describe('designer tab key (features-13)', () => {
  it('is the same key F4 uses for the object, so a created or renamed object reuses its tab', () => {
    const ctx = { connectionId: 'c1', database: null, schema: 'dbo' };
    expect(designerKey('table', ctx, 'Notes')).toBe('table|c1||dbo|Notes');
    expect(designerKey('view', { ...ctx, database: 'Shop' }, 'vActive')).toBe('view|c1|Shop|dbo|vActive');
    expect(designerKey('view', ctx, 'a')).not.toBe(designerKey('table', ctx, 'a'));
  });
});

describe('designer tab key across entry points (features-13)', () => {
  afterEach(() => useCatalog.setState({ conns: {} }));

  it('a designer opened from a console (database null) and from the explorer (main) share one key', () => {
    useCatalog.setState({
      conns: { c_sq: { databases: { current: 'main', databases: [{ name: 'main' }] }, status: 'ready', error: null } as unknown as ConnCatalog },
    });
    const fromConsole = { connectionId: 'c_sq', database: null, schema: 'main' };
    const fromExplorer = { connectionId: 'c_sq', database: 'main', schema: 'main' };
    expect(designerKey('view', fromConsole, 'vActiveR1')).toBe(designerKey('view', fromExplorer, 'vActiveR1'));
    expect(designerKey('view', fromConsole, 'vActiveR1')).toBe('view|c_sq|main|main|vActiveR1');
    expect(designerKey('table', fromConsole, 'NotesR1')).toBe(designerKey('table', fromExplorer, 'NotesR1'));
    // another database stays another key
    expect(designerKey('table', { ...fromExplorer, database: 'aux' }, 'NotesR1')).not.toBe(designerKey('table', fromConsole, 'NotesR1'));
  });
});

describe('view designer change state (features-r1-03)', () => {
  const server = { name: 'vActive', body: 'SELECT Id FROM Customers', options: undefined as unknown as ViewOptions };
  const base = { loaded: true, server, name: 'vActive', body: server.body, options: NO_VIEW_OPTIONS, handEdited: false };

  it('an unchanged view shows "No changes" (even when the engine sends no options)', () => {
    expect(viewDirty(base)).toBe(false);
    expect(viewUnchanged(base)).toBe(true);
    expect(viewUnchanged({ ...base, options: { force: false, checkOption: false, schemaBinding: false } })).toBe(true);
  });

  it('any edit (body, name, options or the DDL preview) is a change', () => {
    expect(viewUnchanged({ ...base, body: `${server.body} WHERE 1 = 1` })).toBe(false);
    expect(viewUnchanged({ ...base, name: 'vActive2' })).toBe(false);
    expect(viewUnchanged({ ...base, name: ' vActive ' })).toBe(true);
    expect(viewUnchanged({ ...base, options: { ...NO_VIEW_OPTIONS, checkOption: true } })).toBe(false);
    expect(viewUnchanged({ ...base, handEdited: true })).toBe(false);
    expect(viewUnchanged({ ...base, loaded: false })).toBe(false);
  });

  it('a new view is never "unchanged"; once applied, the applied model is the server one', () => {
    const fresh = { ...base, server: null, body: 'SELECT\n    \nFROM ' };
    expect(viewDirty(fresh)).toBe(false);
    expect(viewUnchanged(fresh)).toBe(false);
    const typed = { ...fresh, body: 'SELECT 1 AS x' };
    expect(viewDirty(typed)).toBe(true);
    // ViewDesigner sets `server` to the applied view (or to its own model when reloading it fails)
    expect(viewUnchanged({ ...typed, server: { name: typed.name, body: typed.body, options: typed.options } })).toBe(true);
  });
});

describe('rebuild confirmation (design-r1-04)', () => {
  const statements = [
    { sql: 'PRAGMA foreign_keys = OFF', kind: 'pragma' },
    { sql: 'DROP VIEW IF EXISTS "CustomerOrderTotals"', kind: 'drop' },
    { sql: 'CREATE TABLE "Customers__new" (\n  "Id" INTEGER)', kind: 'rebuild' },
    { sql: 'INSERT INTO "sqlite_sequence" (name, seq)\nSELECT 1', kind: 'rebuild', warning: 'Keeps the AUTOINCREMENT counter, so ids of deleted rows are never reused.' },
    { sql: 'DROP TABLE "Customers"', kind: 'rebuild' },
    { sql: 'CREATE INDEX "IX_Customers_Email" ON "Customers" ("Email")', kind: 'index' },
    { sql: 'CREATE TRIGGER TR_Customers_Audit AFTER UPDATE ON Customers BEGIN SELECT 1; END', kind: 'create' },
    { sql: 'CREATE VIEW "CustomerOrderTotals" AS\nSELECT 1', kind: 'create' },
    { sql: 'CREATE VIEW main.[vActive] AS SELECT 2', kind: 'create' },
  ] as DdlStatement[];

  it('lists SQL as code and the scripter annotations as notes after their statement', () => {
    const items = confirmItems(statements);
    expect(items).toContainEqual({ text: 'DROP VIEW IF EXISTS "CustomerOrderTotals"', kind: 'sql' });
    expect(items).toContainEqual({ text: 'CREATE TABLE "Customers__new" (', kind: 'sql' });
    const i = items.findIndex((x) => typeof x !== 'string' && x.kind === 'note');
    expect(items[i]).toEqual({ text: 'Keeps the AUTOINCREMENT counter, so ids of deleted rows are never reused.', kind: 'note' });
    expect(items[i - 1]).toEqual({ text: 'INSERT INTO "sqlite_sequence" (name, seq)', kind: 'sql' });
    expect(items.some((x) => typeof x !== 'string' && x.text.startsWith('PRAGMA'))).toBe(false);
  });

  it('names the views it recreates and counts triggers and indexes', () => {
    expect(recreatedSummary(statements)).toBe('Views recreated: CustomerOrderTotals, vActive. 1 trigger recreated. 1 index recreated.');
    expect(recreatedSummary(statements.slice(0, 8))).toBe('View recreated: CustomerOrderTotals. 1 trigger recreated. 1 index recreated.');
    expect(recreatedSummary([{ sql: 'ALTER TABLE t ADD COLUMN x INT' }])).toBe('');
  });

  it('renders notes as muted prose and SQL as code', () => {
    const items = confirmItemList([{ text: 'DROP TABLE "Customers"', kind: 'sql' }, { text: 'Keeps the counter.', kind: 'note' }, 'UPDATE x']);
    useUi.setState({ confirm: { title: 'Rebuild the table?', message: 'm', items, resolve: () => undefined } });
    render(<ConfirmDialog />);
    const note = screen.getByText('Keeps the counter.');
    expect(note.tagName).toBe('LI');
    expect(note).toHaveClass('muted');
    expect(note.querySelector('code')).toBeNull();
    expect(screen.getByText('DROP TABLE "Customers"').tagName).toBe('CODE');
    expect(screen.getByText('UPDATE x').tagName).toBe('CODE');
    useUi.setState({ confirm: null });
  });
});
