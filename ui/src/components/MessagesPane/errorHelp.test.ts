import { beforeEach, describe, expect, it } from 'vitest';
import type { CatalogSchema } from '../../api/types';
import { didYouMeanFixes, editDistance, suggestIdentifier } from '../../editor/markers-core';
import { useCatalog, type DbCatalog } from '../../store/catalog';
import { didYouMean, errorHelp, replaceIdentifier, unknownIdentifier } from './errorHelp';

const schema = {
  name: 'main', version: 1,
  objects: [
    { t: 'table', n: 'Customers', c: [['Id', 'INTEGER', 0, 1, 1, null], ['FirstName', 'TEXT', 1, 0, 0, null], ['City', 'TEXT', 1, 0, 0, null]] },
    { t: 'table', n: 'Orders', c: [['Id', 'INTEGER', 0, 1, 1, null], ['CustomerId', 'INTEGER', 0, 0, 0, null]] },
    { t: 'view', n: 'CustomerOrderTotals', c: [] },
  ],
} as unknown as CatalogSchema;

describe('error guidance (design-22 / design-p8)', () => {
  beforeEach(() => {
    useCatalog.setState({ dbs: { 'c1\u0001main': { connectionId: 'c1', database: 'main', loaded: { main: schema } } as unknown as DbCatalog } });
  });

  it('extracts the unknown identifier from SQLite, SQL Server and Oracle errors', () => {
    expect(unknownIdentifier('[SQLITE_ERROR] no such table: Custmers')).toEqual({ kind: 'table', name: 'Custmers' });
    expect(unknownIdentifier("Invalid object name 'dbo.Custmers'.")).toEqual({ kind: 'table', name: 'Custmers' });
    expect(unknownIdentifier('no such column: c.Citty')).toEqual({ kind: 'column', name: 'Citty' });
    expect(unknownIdentifier('ORA-00904: "C"."CITTY": invalid identifier')).toEqual({ kind: 'column', name: 'CITTY' });
  });

  it('suggests the closest catalog name', () => {
    expect(didYouMean('c1', 'no such table: Custmers')).toEqual({ kind: 'table', name: 'Custmers', suggestion: 'Customers' });
    expect(didYouMean('c1', 'no such column: Citty', 'select Citty from Customers')?.suggestion).toBe('City');
    expect(didYouMean('c1', 'no such table: Invoices')).toBeNull();
    expect(suggestIdentifier('orders', ['Orders'])).toBeNull(); // only case differs: not a typo
    expect(editDistance('Custmers', 'Customers')).toBe(1);
    expect(editDistance('Ordres', 'Orders')).toBe(1); // transposition
  });

  it('maps common errors to one sentence and an action', () => {
    expect(errorHelp(null, 'database is locked')?.action?.command).toBe('connections.showActive');
    expect(errorHelp(null, 'near "FORM": syntax error')?.sentence).toMatch(/Syntax error near “FORM”/);
    expect(errorHelp('READ_ONLY', 'refused')?.sentence).toMatch(/read-only/);
    expect(errorHelp(null, 'something unusual')).toBeNull();
  });

  it('lock wait: the engine text already says what to do, so only the action is added (design-r1-06)', () => {
    const named = errorHelp('SQLITE_BUSY', 'Database is locked by another session: Console 1 from an earlier window (open transaction). Commit or roll back there, then run again.');
    expect(named).toEqual({ sentence: '', action: { label: 'Show sessions', command: 'connections.showActive' } });
    const unknown = errorHelp('SQLITE_BUSY', 'Database is locked by another session or application. Wait for it to finish (or end its transaction), then run again.');
    expect(unknown?.sentence).toBe('');
    expect(unknown?.action?.label).toBe('Show sessions');
    // A bare driver message still gets the full sentence.
    expect(errorHelp(null, 'database is locked')?.sentence).toMatch(/Another session holds a lock/);
  });

  it('Replace edits the identifier on the error line (whole words only)', () => {
    const sql = 'select * from Custmers\n-- Custmers2\nselect 1 from Custmers c';
    expect(replaceIdentifier(sql, 'Custmers', 'Customers', 3)).toBe('select * from Custmers\n-- Custmers2\nselect 1 from Customers c');
    expect(replaceIdentifier(sql, 'Custmers', 'Customers', null)).toBe('select * from Customers\n-- Custmers2\nselect 1 from Custmers c');
    expect(replaceIdentifier('select 1', 'Custmers', 'Customers', 1)).toBeNull();
  });

  it('editor quick fixes offer the same suggestion for unknown-table markers', () => {
    const m = { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 23, severity: 4, message: "Unknown table 'Custmers'", code: 'unknown-table' };
    const fixes = didYouMeanFixes([m, { ...m, code: 'other' }], () => 'Custmers', () => ['Customers', 'Orders']);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ title: 'Did you mean Customers? Replace “Custmers”', text: 'Customers', range: { startColumn: 15, endColumn: 23 } });
  });
});
