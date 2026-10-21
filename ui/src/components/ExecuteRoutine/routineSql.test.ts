// Execute routine: the generated call per dialect. Values are always binds; the SQL holds placeholders only.
import { describe, expect, it } from 'vitest';
import {
  buildRoutineCall, initialInput, paramKindOf, specParams, valueEditorOf, type ParamInput, type RoutineSpec,
} from './routineSql';

const v = (value: string): ParamInput => ({ mode: 'value', value });
const NULL: ParamInput = { mode: 'null', value: '' };
const DEF: ParamInput = { mode: 'default', value: '' };

function spec(dialect: RoutineSpec['dialect'], kind: RoutineSpec['kind'], schema: string, name: string, tuples: Parameters<typeof specParams>[0], extra: Partial<RoutineSpec> = {}): RoutineSpec {
  return { dialect, kind, schema, name, ...specParams(tuples), ...extra };
}

describe('SQL Server', () => {
  const proc = spec('tsql', 'proc', 'dbo', 'MonthlyReport', [['@Year', 'int', 'in', 0], ['@Month', 'int', 'in', 1], ['@Total', 'money', 'out', 0]]);

  it('EXEC with named binds, OUTPUT variables declared and returned with the return value', () => {
    const c = buildRoutineCall(proc, [v('2024'), v('3'), v('')]);
    expect(c.sql).toBe(
      'DECLARE @return_value int, @Total money;\n'
      + 'EXEC @return_value = [dbo].[MonthlyReport]\n    @Year = @Year,\n    @Month = @Month,\n    @Total = @Total OUTPUT;\n'
      + 'SELECT @return_value AS [Return value], @Total AS [Total];',
    );
    expect(c.params).toEqual([{ name: 'Year', kind: 'int', value: 2024 }, { name: 'Month', kind: 'int', value: 3 }]);
    expect(c.errors).toEqual([null, null, null]);
    // never the values in the text
    expect(c.sql).not.toMatch(/2024/);
  });

  it('a parameter on its default is left out; NULL is written as NULL; empty numbers are errors', () => {
    const c = buildRoutineCall(proc, [NULL, DEF, v('')]);
    expect(c.sql).toContain('EXEC @return_value = [dbo].[MonthlyReport] @Year = NULL, @Total = @Total OUTPUT;');
    expect(c.params).toEqual([]);
    const bad = buildRoutineCall(proc, [v(''), DEF, v('')]);
    expect(bad.errors[0]).toMatch(/Enter a value/);
    expect(buildRoutineCall(proc, [v('x'), DEF, v('')]).errors[0]).toBe('Whole number');
  });

  it('scalar functions SELECT with DEFAULT for omitted arguments; table-valued functions SELECT * FROM', () => {
    const fn = spec('tsql', 'func', 'dbo', 'fnTax', [['@amount', 'decimal(12,2)', 'in', 0], ['@rate', 'decimal(5,2)', 'in', 1], ['', 'decimal(12,2)', 'return', 0]]);
    const c = buildRoutineCall(fn, [v('19.90'), DEF]);
    expect(c.sql).toBe('SELECT [dbo].[fnTax](@amount, DEFAULT) AS [Result];');
    expect(c.params).toEqual([{ name: 'amount', kind: 'decimal', value: '19.90' }]);
    const tvf = spec('tsql', 'tablefunc', 'sales', 'Orders Of', [['@id', 'bigint', 'in', 0]]);
    expect(buildRoutineCall(tvf, [v('7')]).sql).toBe('SELECT * FROM [sales].[Orders Of](@id);');
  });

  it('a parameter named like the return variable does not collide with it', () => {
    const p = spec('tsql', 'proc', 'dbo', 'p', [['@return_value', 'int', 'in', 0]]);
    expect(buildRoutineCall(p, [v('1')]).sql).toMatch(/^DECLARE @return_value_ int;\nEXEC @return_value_ = \[dbo\]\.\[p\] @return_value = @return_value;/);
  });
});

describe('Oracle', () => {
  it('an anonymous block with named notation and :binds; OUT and REF CURSOR are out binds', () => {
    const p = spec('plsql', 'proc', 'SHOP', 'GET_ORDERS', [['P_CUST', 'NUMBER', 'in', 0], ['P_FROM', 'DATE', 'in', 1], ['P_COUNT', 'NUMBER', 'out', 0], ['P_CUR', 'SYS_REFCURSOR', 'out', 0]]);
    const c = buildRoutineCall(p, [v('42'), DEF, v(''), v('')]);
    expect(c.sql).toBe('BEGIN\n  SHOP.GET_ORDERS(P_CUST => :p_cust, P_COUNT => :p_count, P_CUR => :p_cur);\nEND;');
    expect(c.params).toEqual([
      { name: 'p_cust', kind: 'decimal', value: '42' },
      { name: 'p_count', kind: 'decimal', value: null, direction: 'out' },
      { name: 'p_cur', kind: 'refcursor', value: null, direction: 'out' },
    ]);
  });

  it('functions assign the result to an out bind; package members are qualified; IN OUT binds keep their value', () => {
    const fn = spec('plsql', 'func', 'SHOP', 'GET_TOTAL', [['', 'NUMBER', 'return', 0], ['P_ID', 'NUMBER(10)', 'in', 0], ['P_ACC', 'VARCHAR2(30)', 'inout', 0]], { packageName: 'ORDER_API' });
    const c = buildRoutineCall(fn, [v('7'), v('x')]);
    expect(c.sql).toBe('BEGIN\n  :result := SHOP.ORDER_API.GET_TOTAL(P_ID => :p_id, P_ACC => :p_acc);\nEND;');
    expect(c.params).toEqual([
      { name: 'p_id', kind: 'int', value: 7 },
      { name: 'p_acc', kind: 'string', value: 'x', direction: 'inout' },
      { name: 'result', kind: 'decimal', value: null, direction: 'out' },
    ]);
  });

  it('a procedure without arguments; reserved or odd names get positional bind names', () => {
    expect(buildRoutineCall(spec('plsql', 'proc', 'SHOP', 'RECALC_STOCK', []), []).sql).toBe('BEGIN\n  SHOP.RECALC_STOCK;\nEND;');
    const c = buildRoutineCall(spec('plsql', 'proc', 'SHOP', 'P', [['DATE', 'DATE', 'in', 0]]), [v('2024-01-02T10:00')]);
    expect(c.sql).toBe('BEGIN\n  SHOP.P("DATE" => :p1);\nEND;');
    expect(c.params).toEqual([{ name: 'p1', kind: 'datetime', value: '2024-01-02T10:00:00' }]);
  });
});

describe('PostgreSQL', () => {
  const proc = spec('pgsql', 'proc', 'public', 'add_order_line', [['p_order_id', 'bigint', 'in', 0], ['p_product_id', 'integer', 'in', 0], ['p_qty', 'integer', 'in', 1], ['p_line_no', 'integer', 'inout', 1]]);

  it('CALL with positional $n binds and casts', () => {
    const c = buildRoutineCall(proc, [v('1'), v('2'), v('3'), v('4')]);
    expect(c.sql).toBe('CALL public.add_order_line(\n    $1::bigint,\n    $2::integer,\n    $3::integer,\n    $4::integer\n);');
    expect(c.params.map((p) => [p.name, p.value])).toEqual([['1', 1], ['2', 2], ['3', 3], ['4', 4]]);
  });

  it('named notation after an argument left on its default', () => {
    const c = buildRoutineCall(proc, [v('1'), v('2'), DEF, NULL]);
    expect(c.sql).toBe('CALL public.add_order_line($1::bigint, $2::integer, p_line_no => NULL);');
    expect(c.params).toHaveLength(2);
  });

  it('functions SELECT; set-returning and OUT functions SELECT * FROM; procedure OUT arguments are NULL', () => {
    const fn = spec('pgsql', 'func', 'public', 'fn_tax', [['amount', 'numeric', 'in', 0], ['', 'numeric', 'return', 0]]);
    expect(buildRoutineCall(fn, [v('10')]).sql).toBe('SELECT public.fn_tax($1::numeric);');
    const srf = spec('pgsql', 'tablefunc', 'public', 'orders_of', [['p_customer_id', 'bigint', 'in', 0]]);
    expect(buildRoutineCall(srf, [v('3')]).sql).toBe('SELECT * FROM public.orders_of($1::bigint);');
    const outFn = spec('pgsql', 'func', 'public', 'stats', [['a', 'integer', 'in', 0], ['total', 'numeric', 'out', 0]]);
    expect(buildRoutineCall(outFn, [v('1'), v('')]).sql).toBe('SELECT * FROM public.stats($1::integer);');
    const outProc = spec('pgsql', 'proc', 'Sales', 'p', [['a', 'integer', 'in', 0], ['b', 'text', 'out', 0]]);
    expect(buildRoutineCall(outProc, [v('1'), v('')]).sql).toBe('CALL "Sales".p($1::integer, NULL);');
  });

  it('an unnamed argument cannot follow a defaulted one', () => {
    const p = spec('pgsql', 'func', 'public', 'f', [['a', 'integer', 'in', 1], ['$2', 'integer', 'in', 0]]);
    expect(buildRoutineCall(p, [DEF, v('1')]).error).toMatch(/no name/);
  });
});

describe('SQLite and helpers', () => {
  it('SQLite has nothing to execute', () => {
    expect(buildRoutineCall({ dialect: 'sqlite', kind: 'proc', schema: 'main', name: 'x', params: [], returnType: null }, []).error).toMatch(/SQLite/);
  });

  it('kinds and editors from declared types; parameters with defaults start on the default, others empty', () => {
    expect(paramKindOf('NUMBER(10)', 'plsql')).toBe('int');
    expect(paramKindOf('NUMBER(10,2)', 'plsql')).toBe('decimal');
    expect(paramKindOf('DATE', 'plsql')).toBe('datetime');
    expect(paramKindOf('date', 'tsql')).toBe('date');
    expect(paramKindOf('bit', 'tsql')).toBe('bool');
    expect(paramKindOf('timestamptz', 'pgsql')).toBe('datetimeoffset');
    expect(paramKindOf('uniqueidentifier', 'tsql')).toBe('guid');
    expect(valueEditorOf('jsonb', 'string')).toBe('multiline');
    expect(valueEditorOf('nvarchar(max)', 'string')).toBe('multiline');
    expect(valueEditorOf('nvarchar(50)', 'string')).toBe('line');
    expect(valueEditorOf('int', 'int')).toBe('number');
    expect(initialInput({ name: 'a', type: 'int', direction: 'in', hasDefault: true })).toEqual({ mode: 'default', value: '' });
    expect(initialInput({ name: 'a', type: 'int', direction: 'in', hasDefault: false })).toEqual({ mode: 'value', value: '' });
  });
});
