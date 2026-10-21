// PostgreSQL specifics of the Go (database/sql + pgx/v5/stdlib, sqlx, pgx) and Java (pgjdbc, JPA / Hibernate 6) generators.
import { describe, expect, it } from 'vitest';
import { generate, joinFiles } from '..';
import type { CgInput, CgRoutine } from '../model';
import type { CodegenOptions } from '../options';
import { shopInput } from './shop';

const include = { model: true, repository: true, procedures: true, interface: false };

function gen(language: 'go' | 'java', opts: Partial<CodegenOptions> = {}, input: CgInput = shopInput('pgsql')): string {
  return joinFiles(generate(input, { language, namespace: language === 'go' ? 'shop' : 'com.example.pg', combined: true, include, ...opts }), '//');
}

/** One routine on its own (exercises shapes the shop fixture does not have). */
function routineInput(r: Omit<CgRoutine, 'package' | 'resultColumns'> & Partial<CgRoutine>): CgInput {
  return { dialect: 'pgsql', objects: [{ package: null, resultColumns: null, ...r }] };
}

describe('Go on PostgreSQL', () => {
  it('uses $n placeholders and scans INSERT ... RETURNING in every flavor (sqlx without Rebind)', () => {
    for (const flavor of ['database-sql', 'sqlx', 'pgx']) {
      const go = gen('go', { flavor });
      expect(go).toContain('WHERE id = $1`');
      expect(go).toContain('VALUES ($1, $2)\nRETURNING id`');
      expect(go).not.toContain('Rebind(');
      expect(go).not.toMatch(/= \?/);
    }
    expect(gen('go', { flavor: 'database-sql' })).toContain('err := s.db.QueryRowContext(ctx, countryInsertSQL, c.Name, c.ISOCode).Scan(&id)');
    expect(gen('go', { flavor: 'pgx' })).toContain('err := s.db.QueryRow(ctx, countryInsertSQL, c.Name, c.ISOCode).Scan(&id)');
  });

  it('runs database/sql and sqlx on pgx/v5/stdlib and the pgx flavor on pgxpool', () => {
    const db = gen('go', { flavor: 'database-sql' });
    expect(db).toContain('_ "github.com/jackc/pgx/v5/stdlib"');
    expect(db).toContain('const DriverName = "pgx"');
    expect(db).not.toContain('"github.com/lib/pq"');
    const pgx = gen('go', { flavor: 'pgx' });
    expect(pgx).toContain('var _ DBTX = (*pgxpool.Pool)(nil)');
    expect(pgx).toContain('return pgx.CollectRows(rows, pgx.RowToStructByName[Country])');
    expect(pgx).toContain('return pgx.CollectOneRow(rows, pgx.RowToAddrOfStructByName[Country])');
    expect(pgx).not.toContain('stdlib');
    expect(pgx).not.toContain('"database/sql"');
  });

  it('maps NULLs to pgtype.* in the pgx flavor with sql.Null*, and keeps *T with the pointer option', () => {
    const nulls = gen('go', { flavor: 'pgx', goNullable: 'sqlNull' });
    expect(nulls).toMatch(/Email\s+pgtype\.Text\s/);
    expect(nulls).toMatch(/CountryID\s+pgtype\.Int4\s/);
    expect(nulls).toMatch(/Day\s+pgtype\.Date\s/);
    expect(nulls).toMatch(/Price\s+pgtype\.Numeric\s/);
    const pointers = gen('go', { flavor: 'pgx', goNullable: 'pointer' });
    expect(pointers).toMatch(/Email\s+\*string\s/);
    expect(pointers).toMatch(/CountryID\s+\*int32\s/);
    expect(gen('go', { flavor: 'database-sql', goNullable: 'sqlNull' })).toMatch(/Email\s+sql\.NullString\s/);
  });

  it('reads arrays as slices (pgtype.Map.SQLScanner on database/sql) and nullable json safely', () => {
    const db = gen('go', { flavor: 'database-sql' });
    expect(db).toMatch(/Tags\s+\[\]string\s+`db:"tags"/);
    expect(db).toMatch(/Counts\s+\[\]int32\s/);
    expect(db).toContain('pgMap.SQLScanner(&c.Tags)');
    // database/sql cannot Scan NULL into a json.RawMessage; pgx can.
    expect(db).toMatch(/Profile\s+\*json\.RawMessage\s/);
    expect(gen('go', { flavor: 'pgx' })).toMatch(/Profile\s+json\.RawMessage\s/);
    expect(gen('go', { flavor: 'pgx' })).not.toContain('SQLScanner');
  });

  it('wraps functions, table functions and procedures (INOUT scanned from the CALL row)', () => {
    const go = gen('go', { flavor: 'database-sql' });
    expect(go).toContain('"SELECT public.fn_tax($1::numeric)"');
    expect(go).toContain('"SELECT id, order_date, total FROM public.orders_of($1)"');
    expect(go).toMatch(/type OrdersOfRow struct \{\n\tID\s+\*int64/);
    expect(go).toContain('func OrdersOf(ctx context.Context, db DBTX, customerID int64) ([]OrdersOfRow, error)');
    expect(go).toContain('call := "CALL public.add_order_line(" + strings.Join(list, ", ") + ")"');
    expect(go).toContain('err := db.QueryRowContext(ctx, call, args...).Scan(&out.LineNo)');
    expect(go).toContain('if qty != nil {\n\t\targs = append(args, *qty)\n\t\tlist = append(list, fmt.Sprintf("p_qty => $%d", len(args)))');
  });

  it('gives overloads distinct names', () => {
    const go = gen('go', { flavor: 'pgx' });
    expect(go).toContain('func FnTax(ctx context.Context, db DBTX, amount pgtype.Numeric) (pgtype.Numeric, error)');
    expect(go).toContain('func FnTax2(ctx context.Context, db DBTX, amount pgtype.Numeric, rate pgtype.Numeric) (pgtype.Numeric, error)');
    expect(go).toContain('"SELECT public.fn_tax($1::numeric, $2::numeric)"');
    // The fixture's overloads are both callable (no defaulted rate), so no ambiguity note is written.
    expect(go).not.toContain('ambiguous while');
    const split = generate(shopInput('pgsql'), { language: 'go', flavor: 'pgx', namespace: 'shop', combined: false, include }).map((f) => f.path);
    expect(split).toEqual(expect.arrayContaining(['public_fn_tax.go', 'public_fn_tax_2.go', 'db.go']));
    expect(new Set(split).size).toBe(split.length);
  });

  it('handles unnamed arguments, OUT parameters of functions and SETOF results', () => {
    const go = gen(
      'go',
      { flavor: 'database-sql' },
      routineInput({
        kind: 'func', schema: 'public', name: 'split_name',
        params: [
          { name: '', dbType: 'text', direction: 'in', hasDefault: false },
          { name: 'first', dbType: 'text', direction: 'out', hasDefault: false },
          { name: 'tags', dbType: 'text[]', direction: 'out', hasDefault: false },
        ],
      }),
    );
    expect(go).toContain('func SplitName(ctx context.Context, db DBTX, arg1 string) (SplitNameResult, error)');
    expect(go).toContain('"SELECT * FROM public.split_name($1)"');
    expect(go).toContain('Scan(&out.First, pgMap.SQLScanner(&out.Tags))');
    const setof = gen('go', { flavor: 'pgx' }, routineInput({ kind: 'func', schema: 'public', name: 'ids', params: [{ name: '', dbType: 'SETOF bigint', direction: 'return', hasDefault: false }] }));
    expect(setof).toContain('return pgx.CollectRows(rows, pgx.RowTo[*int64])');
  });

  it('notes enum labels and keeps comment text intact', () => {
    const go = gen('go', { flavor: 'database-sql' });
    expect(go).toContain('// enum order_status: new, paid, shipped, cancelled');
    expect(go).toContain('// Country is a row of public.countries: ISO countries.');
    expect(go).not.toContain('text[] in PostgreSQL text form');
    expect(gen('go', { flavor: 'sqlx' })).toMatch(/Tags\s+\*string\s.*text\[\] in PostgreSQL text form/);
  });
});

describe('Java on PostgreSQL', () => {
  it('binds ? and reads INSERT ... RETURNING with executeQuery', () => {
    const java = gen('java', { flavor: 'jdbc' });
    expect(java).toContain('VALUES (?, ?)\n            RETURNING id""";');
    expect(java).toContain('PreparedStatement ps = c.prepareStatement(INSERT_SQL)) {');
    expect(java).toContain('try (ResultSet rs = ps.executeQuery()) {');
    expect(java).not.toContain('getGeneratedKeys');
    expect(java).not.toContain('$1');
  });

  it('maps uuid / timestamptz / arrays / interval through pgjdbc and casts json, enums and inet server-side', () => {
    const java = gen('java', { flavor: 'jdbc' });
    expect(java).toContain('rs.getObject("id", UUID.class)');
    expect(java).toContain('rs.getObject("created_at", OffsetDateTime.class)');
    expect(java).toContain('rs.getObject("opens_tz", OffsetTime.class)');
    expect(java).toContain('import java.time.OffsetTime;');
    expect(java).toContain('PgJdbc.array(rs.getArray("counts"), Integer[].class)');
    expect(java).toContain('PgJdbc.strings(rs.getArray("statuses"))');
    expect(java).toContain('ps.setArray(5, e.tags() == null ? null : c.createArrayOf("text", e.tags()));');
    expect(java).toContain('ps.setObject(4, e.profile(), Types.OTHER);');
    expect(java).toContain('ps.setObject(14, e.ip(), Types.OTHER);');
    expect(java).toContain('PgJdbc.duration(rs.getObject("wait"))');
    expect(java).toContain('import org.postgresql.util.PGInterval;');
    // A record component cannot be called wait (Object.wait() is final).
    expect(java).toContain('Duration wait_,');
  });

  it('calls functions with SELECT and procedures with CALL, reading INOUT values from the row', () => {
    const java = gen('java', { flavor: 'jdbc' });
    expect(java).toContain('c.prepareStatement("SELECT public.fn_tax(?::numeric)")');
    expect(java).toContain('public BigDecimal fnTax(BigDecimal amount, BigDecimal rate) throws SQLException {');
    expect(java).toContain('public List<OrdersOfRow> ordersOf(Long customerId) throws SQLException {');
    expect(java).toContain('"SELECT id, order_date, total FROM public.orders_of(?)"');
    expect(java).toContain('String sql = "CALL public.add_order_line(" + String.join(", ", list) + ")";');
    expect(java).toContain('return new AddOrderLineResult(\n                        rs.getObject(1, Integer.class));');
    expect(java).not.toContain('prepareCall');
  });

  it('numbers overloads whose Java signatures collide', () => {
    const input: CgInput = {
      dialect: 'pgsql',
      objects: ['text', 'character varying'].map((t) => ({
        kind: 'func' as const, schema: 'public', package: null, name: 'norm', resultColumns: null,
        params: [{ name: 's', dbType: t, direction: 'in' as const, hasDefault: false }, { name: '', dbType: 'text', direction: 'return' as const, hasDefault: false }],
      })),
    };
    const java = gen('java', { flavor: 'jdbc' }, input);
    expect(java).toContain('public String norm(String s) throws SQLException {');
    expect(java).toContain('public String norm2(String s) throws SQLException {');
    expect(java).toContain('"SELECT public.norm(?::character varying)"');
  });

  it('annotates JPA entities for PostgreSQL (identity, schema, jsonb, enums, arrays, interval)', () => {
    const jpa = gen('java', { flavor: 'jpa' });
    expect(jpa).toContain('@Table(name = "invoices", schema = "sales")');
    expect(jpa).toContain('@GeneratedValue(strategy = GenerationType.IDENTITY)');
    expect(jpa).toContain('@org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.JSON)\n    @Column(name = "profile", columnDefinition = "jsonb")');
    expect(jpa).toContain('@org.hibernate.annotations.ColumnTransformer(write = "?::order_status")');
    expect(jpa).toContain('@Column(name = "counts", columnDefinition = "integer[]")');
    expect(jpa).toContain('@org.hibernate.annotations.JdbcTypeCode(org.hibernate.type.SqlTypes.INTERVAL_SECOND)');
    expect(jpa).toContain('@Transient\n    private Object location;');
    // @Lob byte[] would be an oid large object on PostgreSQL.
    expect(jpa).not.toContain('@Lob');
    expect(jpa).toContain('@Column(name = "`user`")');
  });
});
