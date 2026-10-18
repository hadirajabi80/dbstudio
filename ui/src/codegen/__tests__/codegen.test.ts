// Unit tests of the codegen building blocks: naming, type mapping, parameter detection and the option switches
// (nullable handling, naming styles, singularisation, reserved words) across languages.
import { describe, expect, it } from 'vitest';
import { generate, joinFiles, LANGUAGES, queryObject } from '..';
import type { CgInput, CgTable } from '../model';
import { camel, escapeIdent, goPascal, pascal, queryFnBase, singularize, snake, splitWords, withSuffix } from '../naming';
import { detectQueryParams, rewriteQuery } from '../sqlgen';
import { resolveType, TYPE_TABLES } from '../types';
import { shopInput } from './shop';

describe('naming', () => {
  it('splits identifiers of every convention', () => {
    expect(splitWords('ORDER_LINES')).toEqual(['ORDER', 'LINES']);
    expect(splitWords('orderLines')).toEqual(['order', 'Lines']);
    expect(splitWords('HTMLParser2')).toEqual(['HTML', 'Parser2']);
    expect(splitWords('@CustomerId')).toEqual(['Customer', 'Id']);
    expect(splitWords('iso-code')).toEqual(['iso', 'code']);
  });

  it('converts between styles', () => {
    expect(pascal('country_id')).toBe('CountryId');
    expect(pascal('ORDER_LINES')).toBe('OrderLines');
    expect(camel('CountryId')).toBe('countryId');
    expect(snake('CountryId')).toBe('country_id');
    expect(snake('OrderDate')).toBe('order_date');
    expect(goPascal('customer_id')).toBe('CustomerID');
    expect(goPascal('api_url')).toBe('APIURL');
    expect(pascal('2fa_code')).toBe('_2FaCode');
  });

  it('singularises table names, keeping case style, with exceptions', () => {
    expect(singularize('Customers')).toBe('Customer');
    expect(singularize('Countries')).toBe('Country');
    expect(singularize('ORDER_LINES')).toBe('ORDER_LINE');
    expect(singularize('vActiveCustomers')).toBe('vActiveCustomer');
    expect(singularize('Addresses')).toBe('Address');
    expect(singularize('Boxes')).toBe('Box');
    expect(singularize('OrderStatuses')).toBe('OrderStatus');
    expect(singularize('People')).toBe('Person');
    expect(singularize('Status')).toBe('Status');
    expect(singularize('News')).toBe('News');
    expect(singularize('Data')).toBe('Data');
    expect(singularize('Invoices')).toBe('Invoice');
    expect(singularize('Metrics', { exceptions: 'Metrics' })).toBe('Metrics');
    expect(singularize('Criteria', { exceptions: 'Criteria=Criterion' })).toBe('Criterion');
  });

  it('escapes reserved words per language', () => {
    expect(escapeIdent('csharp', 'class')).toBe('@class');
    expect(escapeIdent('python', 'class')).toBe('class_');
    expect(escapeIdent('go', 'type')).toBe('type_');
    expect(escapeIdent('java', 'class')).toBe('class_');
    expect(escapeIdent('typescript', 'select')).toBe('select');
    expect(escapeIdent('csharp', 'Name')).toBe('Name');
  });
});

describe('type mapping', () => {
  it('every row of every dialect table defines every language', () => {
    for (const [dialect, table] of Object.entries(TYPE_TABLES)) {
      for (const [key, row] of Object.entries(table)) {
        for (const lang of ['cs', 'go', 'ts', 'java', 'py'] as const) {
          expect(row[lang], `${dialect}.${key}.${lang}`).toBeTruthy();
        }
        expect(row.logical, `${dialect}.${key}.logical`).toBeTruthy();
      }
    }
  });

  it('maps SQL Server types with sizes', () => {
    const t = resolveType('tsql', 'nvarchar(100)');
    expect([t.cs, t.go, t.ts, t.java, t.py, t.length]).toEqual(['string', 'string', 'string', 'String', 'str', 100]);
    expect(resolveType('tsql', 'nvarchar(max)').length).toBeNull();
    expect(resolveType('tsql', 'decimal(18,2)')).toMatchObject({ cs: 'decimal', java: 'BigDecimal', precision: 18, scale: 2 });
    expect(resolveType('tsql', 'float(24)').cs).toBe('float');
    expect(resolveType('tsql', 'uniqueidentifier').cs).toBe('Guid');
    expect(resolveType('tsql', 'datetimeoffset(7)').java).toBe('OffsetDateTime');
  });

  it('splits Oracle NUMBER by precision and scale', () => {
    expect(resolveType('plsql', 'NUMBER(9)').cs).toBe('int');
    expect(resolveType('plsql', 'NUMBER(10)').cs).toBe('long');
    expect(resolveType('plsql', 'NUMBER(12,2)').cs).toBe('decimal');
    expect(resolveType('plsql', 'NUMBER').cs).toBe('decimal');
    expect(resolveType('plsql', 'NUMBER(1)').cs).toBe('int');
    expect(resolveType('plsql', 'NUMBER(1)', { numberOneAsBool: true }).cs).toBe('bool');
    expect(resolveType('plsql', 'TIMESTAMP(6) WITH TIME ZONE').cs).toBe('DateTimeOffset');
    expect(resolveType('plsql', 'INTERVAL DAY(2) TO SECOND(0)').go).toBe('time.Duration');
    expect(resolveType('plsql', 'VARCHAR2(100 CHAR)').length).toBe(100);
  });

  it('falls back to SQLite affinity, then to the wire kind, then to object with known=false', () => {
    expect(resolveType('sqlite', 'UNSIGNED INTEGER').go).toBe('int64');
    expect(resolveType('sqlite', 'VARYING CHARACTER(20)').py).toBe('str');
    expect(resolveType('sqlite', '').logical).toBe('binary');
    expect(resolveType('tsql', 'my_udt', { kind: 'string' })).toMatchObject({ cs: 'string', known: true });
    expect(resolveType('tsql', 'my_udt')).toMatchObject({ cs: 'object', known: false });
  });
});

describe('query parameters', () => {
  it('detects T-SQL parameters but not declared variables or @@globals', () => {
    const p = detectQueryParams('DECLARE @x int = 1; SELECT * FROM t WHERE a = @id AND b = @x AND c = @@ROWCOUNT AND d = @id', 'tsql');
    expect(p.map((x) => x.name)).toEqual(['id']);
  });

  it('detects Oracle binds, ignoring SQL*Plus substitution variables', () => {
    expect(detectQueryParams('SELECT * FROM t WHERE a = :id AND b = &sub AND c = :name', 'plsql').map((x) => x.name)).toEqual(['id', 'name']);
  });

  it('numbers positional ? parameters and keeps given types', () => {
    const p = detectQueryParams('SELECT * FROM t WHERE a = ? AND b = ?', 'sqlite', { p2: 'int' });
    expect(p).toEqual([
      { name: 'p1', positional: true, type: 'string' },
      { name: 'p2', positional: true, type: 'int' },
    ]);
  });

  it('rewrites placeholders for drivers without named parameters', () => {
    expect(rewriteQuery('SELECT 1 WHERE a = @id OR b = @id OR c = @n', 'tsql', 'q')).toEqual({ sql: 'SELECT 1 WHERE a = ? OR b = ? OR c = ?', order: ['id', 'id', 'n'] });
    expect(rewriteQuery('SELECT 1 WHERE a = @id OR b = @id', 'tsql', 'atP').sql).toBe('SELECT 1 WHERE a = @p1 OR b = @p1');
    expect(rewriteQuery("SELECT ':x' FROM t WHERE a = :x", 'plsql', 'colonN').sql).toBe("SELECT ':x' FROM t WHERE a = :1");
  });
});

const keywordsTable: CgTable = {
  kind: 'table', schema: 'dbo', name: 'Statuses', comment: null, primaryKey: ['Id'], foreignKeys: [],
  columns: [
    { name: 'Id', dbType: 'int', nullable: false, pk: true, identity: true, computed: false },
    { name: 'class', dbType: 'nvarchar(20)', nullable: false, pk: false, identity: false, computed: false },
    { name: 'type', dbType: 'int', nullable: true, pk: false, identity: false, computed: false },
    { name: 'select', dbType: 'bit', nullable: true, pk: false, identity: false, computed: false },
  ],
};
const one = (t: CgTable): CgInput => ({ dialect: 'tsql', objects: [t] });
const text = (input: CgInput, o: Parameters<typeof generate>[1]) => joinFiles(generate(input, o));

describe('options', () => {
  it('nullable columns become nullable types with each language default', () => {
    const input = shopInput('tsql', { query: false });
    const cs = text(input, { language: 'csharp', flavor: 'model' });
    expect(cs).toContain('public string? Email { get; set; }');
    expect(cs).toContain('public string Name { get; set; } = "";');
    expect(cs).toContain('public int? CountryId { get; set; }');
    const go = text(input, { language: 'go', flavor: 'database-sql' });
    expect(go).toMatch(/Email\s+\*string/);
    const goNull = text(input, { language: 'go', flavor: 'database-sql', goNullable: 'sqlNull' });
    expect(goNull).toMatch(/Email\s+sql\.NullString/);
    expect(goNull).toMatch(/CountryID\s+sql\.NullInt32/);
    const ts = text(input, { language: 'typescript', flavor: 'interface' });
    expect(ts).toContain('email: string | null;');
    expect(text(input, { language: 'typescript', flavor: 'interface', tsNullable: 'optional' })).toContain('email?: string;');
    const java = text(input, { language: 'java', flavor: 'jdbc' });
    expect(java).toContain('Integer countryId');
    expect(java).toContain('int id,');
    const py = text(input, { language: 'python', flavor: 'dataclass' });
    expect(py).toContain('email: str | None');
    expect(text(input, { language: 'python', flavor: 'dataclass', pyUnionSyntax: false })).toContain('email: Optional[str]');
  });

  it('C# without nullable reference types disables the nullable context', () => {
    const cs = text(shopInput('tsql', { query: false }), { language: 'csharp', flavor: 'model', nullableReferenceTypes: false });
    expect(cs).toContain('#nullable disable');
    expect(cs).toContain('public string Email { get; set; }');
  });

  it('naming styles and singularisation apply to members and types', () => {
    const input = shopInput('sqlite', { query: false });
    expect(text(input, { language: 'csharp', flavor: 'model' })).toContain('public int? CountryId { get; set; }');
    expect(text(input, { language: 'csharp', flavor: 'model', naming: 'asIs' })).toContain('public int? country_id { get; set; }');
    expect(text(input, { language: 'typescript', flavor: 'interface', naming: 'snake' })).toContain('country_id: number | null;');
    expect(text(input, { language: 'csharp', flavor: 'model' })).toContain('class Customer');
    expect(text(input, { language: 'csharp', flavor: 'model', singularize: false })).toContain('class Customers');
    expect(text(input, { language: 'csharp', flavor: 'model', singularExceptions: 'customers' })).toContain('class Customers');
  });

  it('escapes reserved words and avoids member = type name collisions', () => {
    const cs = text(one(keywordsTable), { language: 'csharp', flavor: 'model', naming: 'asIs' });
    expect(cs).toContain('public string @class { get; set; }');
    const py = text(one(keywordsTable), { language: 'python', flavor: 'dataclass' });
    expect(py).toContain('class_: str');
    const java = text(one(keywordsTable), { language: 'java', flavor: 'jdbc' });
    expect(java).toContain('String class_');
    expect(text(one(keywordsTable), { language: 'csharp', flavor: 'model' })).toContain('class Status');
    const shop = text(shopInput('tsql', { query: false }), { language: 'csharp', flavor: 'model' });
    expect(shop).toContain('public string? Keyword1 { get; set; }');
  });

  it('identity columns are excluded from INSERT in every CRUD flavor', () => {
    for (const [language, flavor] of [['csharp', 'dapper'], ['csharp', 'adonet'], ['go', 'database-sql'], ['typescript', 'driver'], ['java', 'jdbc'], ['python', 'dataclass'], ['sql', 'insert']] as const) {
      const out = text(one(keywordsTable), { language, flavor });
      expect(out, `${language}/${flavor}`).toMatch(/INSERT INTO dbo\.Statuses \((\s*)class,/);
    }
  });

  it('query code binds every detected parameter through the driver', () => {
    const input = shopInput('tsql');
    const q = input.objects.filter((o) => o.kind === 'query');
    const qi = { dialect: 'tsql' as const, objects: q };
    expect(text(qi, { language: 'csharp', flavor: 'dapper' })).toContain('new { customerId, minTotal }');
    expect(text(qi, { language: 'go', flavor: 'database-sql' })).toContain('sql.Named("customerId", customerID), sql.Named("minTotal", minTotal)');
    expect(text(qi, { language: 'typescript', flavor: 'driver' })).toContain(".input('customerId', sql.Int, customerId)");
    const java = text(qi, { language: 'java', flavor: 'jdbc' });
    expect(java).toContain('WHERE c.Id = ? AND o.Total > ?');
    expect(java).toContain('ps.setObject(1, customerId, Types.INTEGER)');
    expect(text(qi, { language: 'python', flavor: 'dataclass' })).toContain('execute(_CUSTOMER_ORDERS_SQL, customer_id, min_total)');
    for (const lang of ['csharp', 'go', 'typescript', 'java', 'python'] as const) {
      // never concatenated: the literal SQL keeps placeholders only
      expect(text(qi, { language: lang, flavor: LANGUAGES.find((l) => l.id === lang)!.flavors[lang === 'typescript' ? 1 : 0].id })).not.toMatch(/\+ ?customerId|\$\{customerId\}|f"/);
    }
  });

  it('procedure wrappers include OUT parameters, the T-SQL return value and REF CURSORs', () => {
    const tsql = shopInput('tsql');
    const cs = text(tsql, { language: 'csharp', flavor: 'dapper' });
    expect(cs).toContain('p.Add("Total", dbType: DbType.Decimal, direction: ParameterDirection.Output, precision: 18, scale: 2);');
    expect(cs).toContain('p.Add("RETURN_VALUE", dbType: DbType.Int32, direction: ParameterDirection.ReturnValue);');
    expect(text(tsql, { language: 'go', flavor: 'database-sql' })).toContain('sql.Named("Total", sql.Out{Dest: &out.Total})');
    expect(text(tsql, { language: 'python', flavor: 'dataclass' })).toContain('@Total = @Total OUTPUT');
    const ora = shopInput('plsql');
    expect(text(ora, { language: 'csharp', flavor: 'dapper' })).toContain('OracleDbType = OracleDbType.RefCursor');
    expect(text(ora, { language: 'csharp', flavor: 'adonet' })).toContain('((OracleRefCursor)ordersParam.Value).GetDataReader()');
    expect(text(ora, { language: 'go', flavor: 'database-sql' })).toContain('godror.WrapRows(ctx, db, ordersCursor)');
    expect(text(ora, { language: 'typescript', flavor: 'driver' })).toContain('type: oracledb.CURSOR');
    expect(text(ora, { language: 'java', flavor: 'jdbc' })).toContain('Types.REF_CURSOR');
    expect(text(ora, { language: 'python', flavor: 'dataclass' })).toContain('cur.var(oracledb.DB_TYPE_CURSOR)');
    // packages become a class / module named after the package
    expect(text(ora, { language: 'csharp', flavor: 'dapper' })).toContain('public sealed class Billing(IDbConnection db)');
    expect(text(ora, { language: 'go', flavor: 'database-sql' })).toContain('func BillingListOpenInvoices(');
  });

  it('per-object files when not combined', () => {
    const files = generate(shopInput('tsql', { query: false }), { language: 'csharp', flavor: 'dapper', combined: false });
    expect(files.map((f) => f.path)).toContain('Customer.cs');
    expect(files.every((f) => f.content.includes('namespace App.Data;'))).toBe(true);
    const go = generate(shopInput('tsql', { query: false }), { language: 'go', flavor: 'database-sql', combined: false });
    expect(go.map((f) => f.path)).toContain('db.go');
  });
});

describe('query names: one suffix each, added by the generator (design-r2-03)', () => {
  const cols = [{ name: 'Id', dbType: 'int', nullable: false, pk: false, identity: false, computed: false }, { name: 'Name', dbType: 'nvarchar(50)', nullable: true, pk: false, identity: false, computed: false }];
  const q = (name: string): CgInput => ({ dialect: 'tsql', objects: [queryObject(name, 'SELECT Id, Name FROM dbo.Customers', 'tsql', cols)] });

  it('helpers', () => {
    expect(withSuffix('Customers', 'query')).toBe('Customers_query');
    expect(withSuffix('CustomersQuery', 'query')).toBe('CustomersQuery');
    expect(withSuffix('customers_row', 'row')).toBe('customers_row');
    expect(withSuffix('Query', 'query')).toBe('Query');
    expect(pascal(queryFnBase('Customers'))).toBe('GetCustomers');
    expect(pascal(queryFnBase('GetOrders'))).toBe('GetOrders');
    expect(pascal(queryFnBase('ListOrders'))).toBe('ListOrders');
    expect(snake(queryFnBase('MonthlySales'))).toBe('get_monthly_sales');
  });

  it('the base name "Customers" gives CustomersRow / CustomersQuery / GetCustomersAsync in every language', () => {
    const cs = text(q('Customers'), { language: 'csharp', flavor: 'dapper' });
    expect(cs).toContain('public sealed class CustomersRow');
    expect(cs).toContain('public static class CustomersQuery');
    expect(cs).toContain('Task<IReadOnlyList<CustomersRow>> GetCustomersAsync(this IDbConnection db');
    const go = text(q('Customers'), { language: 'go', flavor: 'database-sql' });
    expect(go).toContain('type CustomersRow struct');
    expect(go).toContain('func GetCustomers(ctx context.Context');
    const ts = text(q('Customers'), { language: 'typescript', flavor: 'driver' });
    expect(ts).toContain('export interface CustomersRow');
    expect(ts).toContain('export async function getCustomers(pool');
    const java = text(q('Customers'), { language: 'java', flavor: 'jdbc' });
    expect(java).toContain('public record CustomersRow(');
    expect(java).toContain('public final class CustomersQuery {');
    expect(text(q('Customers'), { language: 'python', flavor: 'dataclass' })).toContain('def get_customers(conn');
    expect(text(q('Customers'), { language: 'json', flavor: 'json-schema' })).toContain('"CustomersRow"');
    for (const [language, flavor] of [['csharp', 'dapper'], ['go', 'database-sql'], ['typescript', 'driver'], ['java', 'jdbc'], ['python', 'dataclass'], ['json', 'json-schema']] as const) {
      expect(text(q('Customers'), { language, flavor }), `${language}`).not.toMatch(/QueryQuery|RowRow|CustomersQueryRow/);
    }
  });

  it('a name that already ends in Query or Row (a tab saved by an older version) is not doubled', () => {
    const cs = text(q('CustomersQuery'), { language: 'csharp', flavor: 'dapper' });
    expect(cs).toContain('public static class CustomersQuery');
    expect(cs).not.toMatch(/CustomersQueryQuery/);
    const java = text(q('Query'), { language: 'java', flavor: 'jdbc' });
    expect(java).toContain('public final class Query {');
    expect(java).toContain('public record QueryRow(');
  });
});
