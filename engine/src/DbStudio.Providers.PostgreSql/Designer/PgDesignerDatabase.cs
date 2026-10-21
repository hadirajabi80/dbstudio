using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Npgsql;

namespace DbStudio.Providers.PostgreSql.Designer;

/// <summary>
/// PostgreSQL side of the designer (docs/PLAN-PG.md 2.7): table models from pg_attribute / pg_attrdef / pg_constraint /
/// pg_index / pg_sequence and comments, view bodies from <c>pg_get_viewdef</c>, and apply on a dedicated unpooled
/// connection in one transaction (PostgreSQL DDL is transactional; CREATE INDEX CONCURRENTLY, ALTER TYPE … ADD VALUE
/// or VACUUM in hand-edited scripts fail with the server's own 25001 and surface as DDL_FAILED).
/// </summary>
public sealed class PgDesignerDatabase : IDesignerDatabase
{
    public string ProviderId => "postgresql";

    public const string ContextQuery = "SELECT current_setting('server_version'), COALESCE(current_schema(), 'public')::text";

    public const string TableQuery =
        "SELECT c.oid, n.nspname::text, c.relname::text, obj_description(c.oid, 'pg_class'), " +
        "(SELECT ts.spcname::text FROM pg_tablespace ts WHERE ts.oid = c.reltablespace) " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE lower(n.nspname) = lower($1) AND lower(c.relname) = lower($2) AND c.relkind IN ('r','p') " +
        "ORDER BY (n.nspname = $1 AND c.relname = $2) DESC, (c.relname = $2) DESC LIMIT 1";

    public const string ColumnsQuery =
        "SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, a.attidentity::text, a.attgenerated::text, " +
        "pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), " +
        "CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN (SELECT co.collname::text FROM pg_collation co WHERE co.oid = a.attcollation) END, " +
        "s.seqstart, s.seqincrement " +
        "FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum " +
        "LEFT JOIN pg_depend dep ON a.attidentity IN ('a','d') AND dep.refclassid = 'pg_class'::regclass AND dep.refobjid = a.attrelid " +
        " AND dep.refobjsubid = a.attnum AND dep.classid = 'pg_class'::regclass AND dep.deptype = 'i' " +
        "LEFT JOIN pg_sequence s ON s.seqrelid = dep.objid " +
        "WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum";

    public const string ConstraintsQuery =
        "SELECT con.conname::text, con.contype::text, pg_get_constraintdef(con.oid, true), " +
        "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) " +
        " JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum), " +
        "fn.nspname::text, fc.relname::text, " +
        "(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) " +
        " JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum), " +
        "con.confdeltype::text, con.confupdtype::text " +
        "FROM pg_constraint con LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace " +
        "WHERE con.conrelid = $1 AND con.contype IN ('p','u','c','f') ORDER BY con.contype, con.conname";

    public const string IndexesQuery =
        "SELECT ic.relname::text, i.indisunique, i.indnkeyatts, " +
        "(SELECT array_agg(COALESCE(a.attname::text, pg_get_indexdef(i.indexrelid, k.ord::int, true)) ORDER BY k.ord) " +
        " FROM unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, ord) LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum), " +
        "(SELECT array_agg((o.opt & 1) = 1 ORDER BY o.ord) FROM unnest(i.indoption::int2[]) WITH ORDINALITY o(opt, ord)), " +
        "pg_get_expr(i.indpred, i.indrelid), am.amname::text " +
        "FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam " +
        // Expression indexes are not part of the table model (its index columns are column names): they are left alone.
        "WHERE i.indrelid = $1 AND i.indexprs IS NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p','u','x')) " +
        "ORDER BY ic.relname";

    public const string ViewQuery =
        "SELECT c.oid, n.nspname::text, c.relname::text, pg_get_viewdef(c.oid, true), c.reloptions::text[] " +
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
        "WHERE lower(n.nspname) = lower($1) AND lower(c.relname) = lower($2) AND c.relkind IN ('v','m') " +
        "ORDER BY (n.nspname = $1 AND c.relname = $2) DESC, (c.relname = $2) DESC LIMIT 1";

    public static IReadOnlyDictionary<string, string> AllQueries { get; } = new Dictionary<string, string>
    {
        [nameof(ContextQuery)] = ContextQuery, [nameof(TableQuery)] = TableQuery, [nameof(ColumnsQuery)] = ColumnsQuery,
        [nameof(ConstraintsQuery)] = ConstraintsQuery, [nameof(IndexesQuery)] = IndexesQuery, [nameof(ViewQuery)] = ViewQuery,
    };

    private static async Task<NpgsqlConnection> OpenAsync(ConnectionProfile profile, string? password, string? database, bool pooling, CancellationToken ct)
    {
        PgDriver.EnsureInitialized();
        var b = PgConnectionStrings.Builder(profile, password, pooling, database);
        b.ApplicationName = "DbStudio designer";
        var conn = new NpgsqlConnection(b.ConnectionString);
        try
        {
            await conn.OpenAsync(ct).ConfigureAwait(false);
            return conn;
        }
        catch
        {
            await conn.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, database, pooling: true, ct).ConfigureAwait(false);
        var rows = await PgDb.QueryAsync(conn, ContextQuery, r => (PgDb.Str(r, 0), PgDb.Str(r, 1)), ct).ConfigureAwait(false);
        return rows.Count == 0
            ? new DdlScriptContext(null, PgDdlScripter.DefaultSchema)
            : new DdlScriptContext(PostgreSqlProvider.ProductVersion(rows[0].Item1), rows[0].Item2 ?? PgDdlScripter.DefaultSchema);
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, database, pooling: true, ct).ConfigureAwait(false);
        return await ReadTableAsync(conn, schema, name, ct).ConfigureAwait(false);
    }

    internal static async Task<TableModel> ReadTableAsync(NpgsqlConnection conn, string? schema, string name, CancellationToken ct)
    {
        schema ??= await PgDb.ScalarAsync(conn, PgCatalogQueries.DefaultSchema, ct).ConfigureAwait(false) as string ?? PgDdlScripter.DefaultSchema;
        var tables = await PgDb.QueryAsync(conn, TableQuery, r => (Oid: PgDb.Oid(r, 0), Schema: r.GetString(1), Name: r.GetString(2), Comment: PgDb.Str(r, 3),
            Tablespace: PgDb.Str(r, 4)), ct, schema, name).ConfigureAwait(false);
        if (tables.Count == 0) throw EngineException.NotFound($"Table {schema}.{name}");
        var t = tables[0];

        var columns = await PgDb.QueryAsync(conn, ColumnsQuery, r =>
        {
            var identity = PgDb.Str(r, 3);
            var generated = PgDb.Str(r, 4) == "s";
            var expr = PgDb.Str(r, 5);
            var isIdentity = identity is "a" or "d";
            return new TableColumnModel
            {
                Id = r.GetString(0),
                Name = r.GetString(0),
                Type = PgTypes.ShortTypeName(r.GetString(1)),
                Nullable = r.GetBoolean(2),
                Default = generated || isIdentity || expr is null ? null : TableDiff.StripOuterParens(expr),
                Identity = isIdentity ? new IdentityModel(PgDb.Long(r, 8) ?? 1, PgDb.Long(r, 9) ?? 1, identity == "a") : null,
                Computed = generated && expr is not null ? new ComputedModel(TableDiff.StripOuterParens(expr), Persisted: true) : null,
                Collation = PgDb.Str(r, 7),
                Comment = PgDb.Str(r, 6),
            };
        }, ct, t.Oid).ConfigureAwait(false);

        var constraints = await PgDb.QueryAsync(conn, ConstraintsQuery, r => (
            Name: r.GetString(0), Type: r.GetString(1), Def: r.GetString(2), Cols: PgDb.Strings(r, 3), RefSchema: PgDb.Str(r, 4), RefTable: PgDb.Str(r, 5),
            RefCols: PgDb.Strings(r, 6), OnDelete: PgDb.Str(r, 7), OnUpdate: PgDb.Str(r, 8)), ct, t.Oid).ConfigureAwait(false);
        PrimaryKeyModel? pk = null;
        var uniques = new List<UniqueModel>();
        var checks = new List<CheckModel>();
        var fks = new List<ForeignKeyModel>();
        foreach (var c in constraints)
        {
            switch (c.Type)
            {
                case "p":
                    pk = new PrimaryKeyModel { Name = c.Name, Columns = [.. c.Cols], Clustered = false };
                    break;
                case "u":
                    uniques.Add(new UniqueModel { Name = c.Name, Columns = [.. c.Cols] });
                    break;
                case "c":
                    checks.Add(new CheckModel { Name = c.Name, Expression = CheckExpression(c.Def) });
                    break;
                case "f":
                    fks.Add(new ForeignKeyModel
                    {
                        Name = c.Name,
                        Columns = [.. c.Cols],
                        RefSchema = c.RefSchema,
                        RefTable = c.RefTable ?? "",
                        RefColumns = [.. c.RefCols],
                        OnDelete = PgCatalogReader.Action(c.OnDelete),
                        OnUpdate = PgCatalogReader.Action(c.OnUpdate),
                    });
                    break;
            }
        }

        var indexes = await PgDb.QueryAsync(conn, IndexesQuery, r =>
        {
            var keyCount = PgDb.Int(r, 2);
            var cols = PgDb.Strings(r, 3);
            var descs = r.IsDBNull(4) ? [] : r.GetFieldValue<bool[]>(4);
            var filter = PgDb.Str(r, 5);
            return new IndexModel
            {
                Name = r.GetString(0),
                Unique = r.GetBoolean(1),
                Columns = cols.Take(keyCount).Select((c, i) => new IndexColumnModel(c, i < descs.Length && descs[i])).ToList(),
                Include = cols.Skip(keyCount).ToList(),
                Filter = filter is null ? null : TableDiff.StripOuterParens(filter),
                Clustered = false,
            };
        }, ct, t.Oid).ConfigureAwait(false);

        return new TableModel
        {
            Schema = t.Schema,
            Name = t.Name,
            Comment = t.Comment,
            Options = new TableOptions { Tablespace = t.Tablespace },
            Columns = columns,
            PrimaryKey = pk,
            Uniques = uniques,
            Indexes = indexes,
            ForeignKeys = fks,
            Checks = checks,
        };
    }

    /// <summary>"CHECK ((amount >= (0)::numeric)) [NOT VALID]" → "amount >= (0)::numeric".</summary>
    public static string CheckExpression(string definition)
    {
        var d = definition.Trim();
        if (d.EndsWith(" NOT VALID", StringComparison.OrdinalIgnoreCase)) d = d[..^" NOT VALID".Length].TrimEnd();
        if (d.EndsWith(" NO INHERIT", StringComparison.OrdinalIgnoreCase)) d = d[..^" NO INHERIT".Length].TrimEnd();
        if (d.StartsWith("CHECK", StringComparison.OrdinalIgnoreCase)) d = d[5..].Trim();
        return TableDiff.StripOuterParens(d);
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var conn = await OpenAsync(profile, password, database, pooling: true, ct).ConfigureAwait(false);
        schema ??= await PgDb.ScalarAsync(conn, PgCatalogQueries.DefaultSchema, ct).ConfigureAwait(false) as string ?? PgDdlScripter.DefaultSchema;
        var rows = await PgDb.QueryAsync(conn, ViewQuery, r => (Schema: r.GetString(1), Name: r.GetString(2), Def: PgDb.Str(r, 3), Options: PgDb.Strings(r, 4)),
            ct, schema, name).ConfigureAwait(false);
        if (rows.Count == 0) throw EngineException.NotFound($"View {schema}.{name}");
        var v = rows[0];
        if (v.Def is null) throw new EngineException(422, ErrorCodes.ProviderError, $"The definition of {v.Schema}.{v.Name} is not visible.");
        var body = v.Def.Trim().TrimEnd(';').TrimEnd();
        var check = v.Options.Any(o => o.StartsWith("check_option=", StringComparison.OrdinalIgnoreCase));
        var ddl = $"CREATE OR REPLACE VIEW {PgSqlText.Qualify(v.Schema, v.Name)} AS\n{body}{(check ? "\nWITH CASCADED CHECK OPTION" : "")};\n";
        return new ViewModel(v.Schema, v.Name, body, new ViewOptions(CheckOption: check), ddl);
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        await using var conn = await OpenAsync(profile, password, request.Database, pooling: false, ct).ConfigureAwait(false);
        var runner = new DdlApplyRunner
        {
            MapError = (ex, sql) => ex is PostgresException pg
                ? PgErrors.FromException(pg, new SqlBatch(sql, 1, 1), pos => pos - 1)
                : PgErrors.ToProviderError(ex),
        };
        return await runner.RunAsync(conn, request.Statements, request.Transactional, ct).ConfigureAwait(false);
    }
}
