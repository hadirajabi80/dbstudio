// PostgreSQL support of the C# and SQL generators (docs/PLAN-PG.md 4.1): Npgsql types and parameters, RETURNING,
// CALL / SELECT f(...) / SELECT * FROM f(...) wrappers, overloads, ON CONFLICT upserts and console-friendly binds.
import { describe, expect, it } from 'vitest';
import { generate, joinFiles } from '..';
import type { CgInput, CgRoutine } from '../model';
import type { CodegenOptions } from '../options';
import { shopInput } from './shop';

const PG = shopInput('pgsql');

function cs(flavor: string, input: CgInput = PG, extra: Partial<CodegenOptions> = {}): string {
  return joinFiles(generate(input, {
    language: 'csharp', flavor, namespace: 'Shop.Pg', combined: true,
    include: { model: true, repository: true, procedures: true, interface: false }, ...extra,
  }));
}

function sql(flavor: string, input: CgInput = PG): string {
  return joinFiles(generate(input, { language: 'sql', flavor, combined: true }), '--');
}

const routine = (r: Partial<CgRoutine> & Pick<CgRoutine, 'kind' | 'name' | 'params'>): CgInput => ({
  dialect: 'pgsql',
  objects: [{ schema: 'public', package: null, resultColumns: null, ...r }],
});

describe('C# for PostgreSQL', () => {
  const ado = cs('adonet');
  const dapper = cs('dapper');
  const ef = cs('efcore');

  it('uses Npgsql types, usings and NpgsqlDbType parameters', () => {
    expect(ado).toContain('using Npgsql;');
    expect(ado).toContain('using NpgsqlTypes;');
    expect(ado).toContain('using System.Net;');
    expect(ado).toContain('using System.Net.NetworkInformation;');
    expect(ado).toContain('public sealed class CustomerRepository(NpgsqlConnection db)');
    expect(ado).toContain('new NpgsqlParameter("Profile", NpgsqlDbType.Jsonb)');
    expect(ado).toContain('new NpgsqlParameter("Id", NpgsqlDbType.Uuid)');
    expect(ado).toContain('new NpgsqlParameter("Ip", NpgsqlDbType.Inet)');
    expect(ado).toContain('new NpgsqlParameter("Counts", NpgsqlDbType.Array | NpgsqlDbType.Integer)');
    expect(ado).not.toMatch(/new SqlParameter\b|OracleParameter|SqliteParameter|AddWithValue\("@/);
  });

  it('writes timestamptz values in UTC and casts enum placeholders', () => {
    expect(ado).toContain('Value = entity.CreatedAt.ToUniversalTime()');
    expect(ado).toContain('status = @Status::order_status');
    expect(ado).toContain('@Statuses::order_status[]');
    // Dapper sends strings as text: json / jsonb need a cast too, ADO.NET types them with NpgsqlDbType.
    expect(dapper).toContain('@Profile::jsonb');
    expect(ado).not.toContain('@Profile::jsonb');
  });

  it('reads identity values back with RETURNING and leaves generated columns out', () => {
    expect(dapper).toMatch(/INSERT INTO public\.countries \(name, iso_code\)\n\s+VALUES \(@Name, @IsoCode\)\n\s+RETURNING id/);
    expect(dapper).toContain('db.ExecuteScalarAsync<long>(new CommandDefinition(InsertSql, entity');
    expect(ado).toContain('return Convert.ToInt64(await cmd.ExecuteScalarAsync(ct));');
    expect(ado).toMatch(/INSERT INTO public\.order_lines \(order_id, line_no, product_id, qty, unit_price\)\n/);
  });

  it('calls procedures with CALL and reads INOUT values from the returned row', () => {
    expect(ado).toContain('cmd.CommandText = $"CALL public.add_order_line({string.Join(", ", callArgs)})";');
    expect(ado).toContain('callArgs.Add("p_line_no => @p_line_no");');
    expect(ado).toContain('await using var reader = await cmd.ExecuteReaderAsync(ct);');
    expect(ado).toContain('return new AddOrderLineResult(reader.IsDBNull(0) ? null : reader.GetInt32(0));');
    expect(dapper).toContain('row["p_line_no"]');
    expect(ado).not.toContain('CommandType.StoredProcedure');
  });

  it('maps a table function to its result-column DTO', () => {
    expect(ado).toContain('cmd.CommandText = "SELECT id, order_date, total FROM public.orders_of(@p_customer_id)";');
    expect(ado).toContain('private static OrdersOfRow MapOrdersOfRow(DbDataReader r) => new()');
    expect(dapper).toContain('QueryAsync<OrdersOfRow>(new CommandDefinition("SELECT id, order_date AS \\"OrderDate\\", total FROM public.orders_of(@p_customer_id)"');
  });

  it('keeps overloads unambiguous: defaulted arguments become required next to a shorter overload', () => {
    expect(dapper).toContain('FnTaxAsync(this IDbConnection db, decimal amount, CancellationToken ct = default)');
    expect(dapper).toContain('FnTaxAsync(this IDbConnection db, decimal amount, decimal rate, CancellationToken ct = default)');
    expect(dapper).toContain('"SELECT public.fn_tax(@amount, @rate)"');
    expect(ado).toContain('cmd.CommandText = "SELECT public.fn_tax(@amount)";');
  });

  it('configures EF Core store types, identity and enum / interval notes', () => {
    expect(ef).toContain('builder.Property(e => e.Profile).HasColumnName("profile").HasColumnType("jsonb")');
    expect(ef).toContain('.HasColumnType("timestamp(3) without time zone")');
    expect(ef).toContain('builder.Property(e => e.Id).HasColumnName("id").UseIdentityByDefaultColumn();');
    expect(ef).toContain('modelBuilder.HasPostgresEnum<T>()');
    expect(ef).toContain('// NpgsqlInterval for month parts');
    expect(ef).toContain('builder.Ignore(e => e.Location);');
  });

  it('falls back to dynamic rows / a DataTable for a set-returning function of unknown shape', () => {
    const input = routine({
      kind: 'func', name: 'recent',
      params: [
        { name: '', dbType: 'integer', direction: 'in', hasDefault: false },
        { name: '', dbType: 'SETOF record', direction: 'return', hasDefault: false },
      ],
    });
    const d = cs('dapper', input);
    expect(d).toContain('Task<IReadOnlyList<dynamic>> RecentAsync(this IDbConnection db, int arg1');
    expect(d).toContain('(await db.QueryAsync(new CommandDefinition("SELECT * FROM public.recent(@arg1)", new { arg1 }');
    const a = cs('adonet', input);
    expect(a).toContain('Task<DataTable> RecentAsync(this NpgsqlConnection db, int arg1');
    expect(a).toContain('rows.Load(reader);');
  });

  it('selects OUT parameters of a function from FROM and returns a result record', () => {
    const input = routine({
      kind: 'func', name: 'split_name',
      params: [
        { name: 'full_name', dbType: 'text', direction: 'in', hasDefault: false },
        { name: 'first', dbType: 'text', direction: 'out', hasDefault: false },
        { name: 'last', dbType: 'text', direction: 'out', hasDefault: false },
        { name: '', dbType: 'record', direction: 'return', hasDefault: false },
      ],
    });
    const a = cs('adonet', input);
    expect(a).toContain('public sealed record SplitNameResult(string? First, string? Last);');
    expect(a).toContain('cmd.CommandText = "SELECT * FROM public.split_name(@full_name)";');
  });
});

describe('SQL scripts for PostgreSQL', () => {
  const all = sql('all');

  it('uses :name binds the DbStudio console accepts, never ?', () => {
    expect(all).toContain('Parameters (:name) are prompted for');
    expect(all).toContain('WHERE id = :id;');
    expect(all).toMatch(/WHERE order_id = :order_id\n {2}AND line_no = :line_no;/);
    expect(all.replace(/^--.*$/gm, '')).not.toMatch(/\?/);
  });

  it('quotes identifiers by PostgreSQL rules', () => {
    expect(all).toContain('    "user" = :user,');
    expect(all).toContain('    "CamelCase" = :CamelCase');
    expect(all).toContain('FROM sales.invoices');
  });

  it('returns identity values from INSERT', () => {
    expect(sql('insert')).toContain('INSERT INTO public.countries (name, iso_code)\nVALUES (:name, :iso_code)\nRETURNING id;');
    expect(sql('insert')).toMatch(/INSERT INTO public\.order_lines \([\s\S]*?\n\);\n/);
  });

  it('upserts with INSERT … ON CONFLICT (pk) DO UPDATE SET c = EXCLUDED.c', () => {
    const m = sql('merge');
    expect(m).toContain('-- public.countries: UPSERT\nINSERT INTO public.countries (id, name, iso_code)\nOVERRIDING SYSTEM VALUE\nVALUES (:id, :name, :iso_code)\nON CONFLICT (id) DO UPDATE SET\n    name = EXCLUDED.name,\n    iso_code = EXCLUDED.iso_code;');
    expect(m).toContain('ON CONFLICT (order_id, line_no) DO UPDATE SET');
    expect(m).not.toContain('line_total');
    expect(m).not.toMatch(/MERGE INTO|FROM DUAL/);
  });

  it('upserts with DO NOTHING when only key columns are writable', () => {
    const input: CgInput = {
      dialect: 'pgsql',
      objects: [{
        kind: 'table', schema: 'public', name: 'tags', primaryKey: ['tag'], foreignKeys: [],
        columns: [{ name: 'tag', dbType: 'text', nullable: false, pk: true, identity: false, computed: false }],
      }],
    };
    expect(sql('merge', input)).toContain('INSERT INTO public.tags (tag)\nVALUES (:tag)\nON CONFLICT (tag) DO NOTHING;');
  });

  it('calls procedures with CALL and functions with SELECT / SELECT * FROM', () => {
    const e = sql('exec');
    expect(e).toContain('-- public.add_order_line: CALL\nCALL public.add_order_line(\n    :p_order_id,\n    :p_product_id,\n    p_qty => :p_qty, -- optional\n    p_line_no => :p_line_no -- inout: returned as a row\n);');
    expect(e).toContain('-- public.fn_tax(numeric): call\nSELECT public.fn_tax(:amount) AS result;');
    expect(e).toContain('-- public.fn_tax(numeric, numeric): call');
    expect(e).toContain('SELECT *\nFROM public.orders_of(:p_customer_id);');
    expect(e).not.toMatch(/BEGIN|END;|DUAL|EXEC /);
  });

  it('passes procedure OUT parameters as NULL and calls unnamed parameters positionally', () => {
    const input = routine({
      kind: 'proc', name: 'next_no',
      params: [
        { name: '', dbType: 'text', direction: 'in', hasDefault: true },
        { name: 'n', dbType: 'integer', direction: 'out', hasDefault: false },
      ],
    });
    expect(sql('exec', input)).toContain('CALL public.next_no(\n    :arg1, -- optional\n    NULL -- out: returned as a row\n);');
  });
});
