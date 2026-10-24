using System.Diagnostics;
using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using DbStudio.Logs.Sql;
using DbStudio.Providers.Snowflake.Gateway;

namespace DbStudio.Providers.Snowflake.Designer;

/// <summary>
/// Snowflake side of the designer: table models from DESCRIBE TABLE plus SHOW PRIMARY / UNIQUE / IMPORTED KEYS and the
/// SHOW TABLES row (comment, clustering key → a clustered index named <see cref="SnowflakeDdlScripter.ClusterIndexName"/>),
/// view bodies from <c>GET_DDL('VIEW', …)</c>, and apply statement by statement on a gateway opened on the target
/// database (Snowflake DDL autocommits: no transaction, stop at the first error).
/// </summary>
public sealed class SnowflakeDesignerDatabase(ISnowflakeGatewayFactory gateways) : IDesignerDatabase
{
    public string ProviderId => "snowflake";

    private static ConnectionProfile WithDatabase(ConnectionProfile profile, string? database)
    {
        if (string.IsNullOrWhiteSpace(database)) return profile;
        var copy = new ConnectionProfile
        {
            Id = profile.Id, Name = profile.Name, ProviderId = profile.ProviderId, ReadOnly = profile.ReadOnly,
            Props = new Dictionary<string, JsonNode?>(profile.Props.Select(kv => KeyValuePair.Create(kv.Key, kv.Value?.DeepClone()))),
            HasPassword = profile.HasPassword, SavePassword = profile.SavePassword,
        };
        copy.Props["database"] = JsonValue.Create(database);
        return copy;
    }

    private static string DefaultSchemaOf(ConnectionProfile profile, string? schema) =>
        !string.IsNullOrWhiteSpace(schema) ? schema
        : profile.GetString("schema") is { Length: > 0 } s ? SnowflakeSql.Normalize(s) : SnowflakeConnectionStrings.DefaultSchema;

    private static async Task<string> DatabaseOfAsync(ISnowflakeGateway g, ConnectionProfile profile, string? database, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(database)) return database;
        if (profile.GetString("database") is { Length: > 0 } d) return SnowflakeSql.Normalize(d);
        var rs = await g.QueryAsync("SELECT CURRENT_DATABASE() AS DATABASE_NAME", ct).ConfigureAwait(false);
        return (rs.Rows.Count == 0 ? null : rs.Str(rs.Rows[0], "DATABASE_NAME"))
               ?? throw EngineException.Validation("No database selected.", new { field = "database" });
    }

    public async Task<DdlScriptContext> GetScriptContextAsync(ConnectionProfile profile, string? password, string? database, string? schema, string? table, CancellationToken ct)
    {
        await using var g = await gateways.OpenAsync(profile, password, ct).ConfigureAwait(false);
        var rs = await g.QueryAsync("SELECT CURRENT_VERSION() AS VERSION", ct).ConfigureAwait(false);
        return new DdlScriptContext(rs.Rows.Count == 0 ? null : rs.Str(rs.Rows[0], "VERSION"), DefaultSchemaOf(profile, schema));
    }

    public async Task<TableModel> ReadTableAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var g = await gateways.OpenAsync(profile, password, ct).ConfigureAwait(false);
        var db = await DatabaseOfAsync(g, profile, database, ct).ConfigureAwait(false);
        var sc = DefaultSchemaOf(profile, schema);
        SqlRowSet describe;
        try
        {
            describe = await g.QueryAsync(SnowflakeSql.DescribeTable(db, sc, name), ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException ex) when (ex.IsNotFoundOrDenied)
        {
            throw EngineException.NotFound($"Table {sc}.{name}");
        }
        var meta = await TryAsync(g, SnowflakeSql.ShowTableLike(db, sc, name), ct).ConfigureAwait(false);
        var pks = await TryAsync(g, SnowflakeSql.ShowPrimaryKeysIn(db, sc, name), ct).ConfigureAwait(false);
        var uks = await TryAsync(g, SnowflakeSql.ShowUniqueKeysIn(db, sc, name), ct).ConfigureAwait(false);
        var fks = await TryAsync(g, SnowflakeSql.ShowImportedKeysIn(db, sc, name), ct).ConfigureAwait(false);
        return BuildTableModel(sc, name, describe, meta, pks, uks, fks);
    }

    private static async Task<SqlRowSet> TryAsync(ISnowflakeGateway g, string sql, CancellationToken ct)
    {
        try { return await g.QueryAsync(sql, ct).ConfigureAwait(false); }
        catch (SnowflakeQueryException) { return new SqlRowSet([], []); }
    }

    /// <summary>Pure assembly of the table model (fixtures-tested).</summary>
    public static TableModel BuildTableModel(string schema, string name, SqlRowSet describe, SqlRowSet meta, SqlRowSet pks, SqlRowSet uks, SqlRowSet fks)
    {
        var columns = new List<TableColumnModel>();
        foreach (var r in describe.Rows)
        {
            var kind = describe.Str(r, "kind") ?? "COLUMN";
            if (!kind.Equals("COLUMN", StringComparison.OrdinalIgnoreCase)) continue;
            var colName = describe.Str(r, "name") ?? "";
            var (type, collation) = SplitCollation(describe.Str(r, "type") ?? "");
            var def = SnowflakeCatalogReader.NullIfEmpty(describe.Str(r, "default"));
            IdentityModel? identity = null;
            if (def is not null && SnowflakeCatalogReader.IsIdentityDefault(def))
            {
                var (start, inc) = SnowflakeCatalogReader.IdentityOf(def);
                identity = new IdentityModel(start, inc);
                def = null;
            }
            columns.Add(new TableColumnModel
            {
                Id = colName,
                Name = colName,
                Type = type,
                Nullable = SnowflakeCatalogReader.Flag(describe, r, "null?"),
                Default = def,
                Identity = identity,
                Collation = collation,
                Comment = SnowflakeCatalogReader.NullIfEmpty(describe.Str(r, "comment")),
            });
        }

        PrimaryKeyModel? pk = null;
        var pkRows = pks.Rows.OrderBy(r => pks.Long(r, "key_sequence") ?? 0).ToList();
        if (pkRows.Count > 0)
            pk = new PrimaryKeyModel { Name = pks.Str(pkRows[0], "constraint_name"), Columns = pkRows.Select(r => pks.Str(r, "column_name") ?? "").ToList(), Clustered = false };
        var uniques = uks.Rows.GroupBy(r => uks.Str(r, "constraint_name") ?? "")
            .Select(g => new UniqueModel { Name = g.Key.Length == 0 ? null : g.Key, Columns = g.OrderBy(r => uks.Long(r, "key_sequence") ?? 0).Select(r => uks.Str(r, "column_name") ?? "").ToList() })
            .ToList();
        var foreignKeys = fks.Rows.GroupBy(r => fks.Str(r, "fk_name") ?? "").Select(g =>
        {
            var rows = g.OrderBy(r => fks.Long(r, "key_sequence") ?? 0).ToList();
            return new ForeignKeyModel
            {
                Name = g.Key.Length == 0 ? null : g.Key,
                Columns = rows.Select(r => fks.Str(r, "fk_column_name") ?? "").ToList(),
                RefSchema = fks.Str(rows[0], "pk_schema_name"),
                RefTable = fks.Str(rows[0], "pk_table_name") ?? "",
                RefColumns = rows.Select(r => fks.Str(r, "pk_column_name") ?? "").ToList(),
                OnDelete = ReferentialActions.Normalize(fks.Str(rows[0], "delete_rule")),
                OnUpdate = ReferentialActions.Normalize(fks.Str(rows[0], "update_rule")),
            };
        }).ToList();

        var metaRow = meta.Rows.FirstOrDefault(r => meta.Str(r, "name") == name);
        var indexes = new List<IndexModel>();
        string? comment = null;
        Dictionary<string, string>? extra = null;
        if (metaRow is not null)
        {
            comment = SnowflakeCatalogReader.NullIfEmpty(meta.Str(metaRow, "comment"));
            extra = SfTableOptions.ToExtra(meta.Str(metaRow, "kind"), meta.Str(metaRow, "retention_time"), meta.Str(metaRow, "change_tracking"));
            // A clustering key on expressions (TO_DATE(TS)) is not representable as index columns: left out of the model,
            // so saving the table never touches it.
            if (SnowflakeCatalogReader.NullIfEmpty(meta.Str(metaRow, "cluster_by")) is { } clusterBy
                && SnowflakeCatalogReader.ClusterKeys(clusterBy) is var keys && keys.All(k => columns.Any(c => c.Name == SnowflakeSql.Normalize(k))))
                indexes.Add(new IndexModel
                {
                    Name = SnowflakeDdlScripter.ClusterIndexName,
                    Clustered = true,
                    Columns = keys.Select(k => new IndexColumnModel(SnowflakeSql.Normalize(k))).ToList(),
                });
        }
        return new TableModel
        {
            Schema = schema,
            Name = name,
            Comment = comment,
            Options = new TableOptions { Extra = extra },
            Columns = columns,
            PrimaryKey = pk,
            Uniques = uniques,
            Indexes = indexes,
            ForeignKeys = foreignKeys,
        };
    }

    /// <summary>"VARCHAR(100) COLLATE 'en-ci'" → ("VARCHAR(100)", "en-ci").</summary>
    public static (string Type, string? Collation) SplitCollation(string type)
    {
        var i = type.IndexOf(" COLLATE ", StringComparison.OrdinalIgnoreCase);
        if (i < 0) return (type.Trim(), null);
        return (type[..i].Trim(), type[(i + 9)..].Trim().Trim('\''));
    }

    public async Task<ViewModel> ReadViewAsync(ConnectionProfile profile, string? password, string? database, string? schema, string name, CancellationToken ct)
    {
        await using var g = await gateways.OpenAsync(profile, password, ct).ConfigureAwait(false);
        var db = await DatabaseOfAsync(g, profile, database, ct).ConfigureAwait(false);
        var sc = DefaultSchemaOf(profile, schema);
        SqlRowSet rs;
        try
        {
            rs = await g.QueryAsync(SnowflakeSql.GetDdl("VIEW", db, sc, name), ct).ConfigureAwait(false);
        }
        catch (SnowflakeQueryException ex) when (ex.IsNotFoundOrDenied)
        {
            throw EngineException.NotFound($"View {sc}.{name}");
        }
        var ddl = rs.Rows.Count == 0 ? null : SqlCells.Str(rs.Rows[0][0]);
        if (string.IsNullOrWhiteSpace(ddl)) throw new EngineException(422, ErrorCodes.ProviderError, $"The definition of {sc}.{name} is not visible.");
        var (body, options) = ViewText.Split(ddl, Dialect.Snowflake);
        return new ViewModel(sc, name, body, options with { CheckOption = false }, ddl.TrimEnd() + "\n");
    }

    public async Task<DdlApplyResult> ApplyAsync(ConnectionProfile profile, string? password, DdlApplyRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);
        var sw = Stopwatch.StartNew();
        await using var g = await gateways.OpenAsync(WithDatabase(profile, request.Database), password, ct).ConfigureAwait(false);
        var executed = 0;
        for (var i = 0; i < request.Statements.Count; i++)
        {
            var sql = request.Statements[i];
            if (string.IsNullOrWhiteSpace(sql) || DdlText.IsTransactionControl(sql)) continue;
            try
            {
                await g.ExecuteAsync(sql.Trim().TrimEnd(';'), ct).ConfigureAwait(false);
                executed++;
            }
            catch (SnowflakeQueryException ex)
            {
                var error = ex.ToError();
                throw new DdlFailedException(DdlApplyRunner.FailureMessage(i, error, executed, false), i, executed, false, error);
            }
        }
        return new DdlApplyResult(true, executed, sw.ElapsedMilliseconds);
    }
}
