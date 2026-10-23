import { describe, expect, it } from 'vitest';
import type { Dialect } from '../api/types';
import { foldName, newObjectRef } from './newObject';

const edit = (dialect: Dialect, schema: string | null = 'dbo') => ({
  dialect,
  ref: { database: 'shop', schema, name: 'NewProcedure', type: 'proc' as const },
});

describe('newObjectRef: the object a New-object script creates', () => {
  it('reads the name the user typed over the template', () => {
    const r = newObjectRef('CREATE OR ALTER PROCEDURE dbo.usp_GetOrders\n  @Id int\nAS\nBEGIN\n  SELECT 1;\nEND', edit('tsql'));
    expect(r).toMatchObject({ schema: 'dbo', name: 'usp_GetOrders', type: 'proc', database: 'shop' });
  });

  it('unquotes bracketed, double-quoted and back-quoted names', () => {
    expect(newObjectRef('CREATE OR ALTER PROCEDURE [Sales].[Get Orders] AS SELECT 1', edit('tsql'))).toMatchObject({ schema: 'Sales', name: 'Get Orders' });
    expect(newObjectRef('CREATE OR REPLACE FUNCTION "public"."Calc"() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql', edit('pgsql', 'public'))).toMatchObject({ schema: 'public', name: 'Calc' });
    expect(newObjectRef('CREATE TRIGGER `trg x` AFTER INSERT ON t BEGIN SELECT 1; END', edit('sqlite', 'main'))).toMatchObject({ name: 'trg x' });
  });

  it('folds unquoted names the way the server stores them', () => {
    expect(newObjectRef('CREATE OR REPLACE PROCEDURE shop.add_line AS BEGIN NULL; END;', edit('plsql', 'SHOP'))).toMatchObject({ schema: 'SHOP', name: 'ADD_LINE' });
    expect(newObjectRef('CREATE OR REPLACE PROCEDURE AddLine() LANGUAGE sql AS $$ SELECT 1 $$', edit('pgsql', 'public'))).toMatchObject({ schema: 'public', name: 'addline' });
  });

  it('keeps the schema of the session when the name is not qualified, and ignores comments', () => {
    const r = newObjectRef('-- CREATE PROCEDURE dbo.old\n/* CREATE PROCEDURE x.y */\nCREATE OR ALTER PROCEDURE usp_New AS SELECT 1', edit('tsql'));
    expect(r).toMatchObject({ schema: 'dbo', name: 'usp_New' });
  });

  it('falls back to the session reference when there is no CREATE header', () => {
    expect(newObjectRef('SELECT 1', edit('tsql'))).toMatchObject({ name: 'NewProcedure', schema: 'dbo' });
  });

  it('foldName applies the same rules to a typed name', () => {
    expect(foldName('my_proc', 'plsql')).toBe('MY_PROC');
    expect(foldName('"my_proc"', 'plsql')).toBe('my_proc');
    expect(foldName('MyProc', 'pgsql')).toBe('myproc');
    expect(foldName('[My Proc]', 'tsql')).toBe('My Proc');
  });
});
