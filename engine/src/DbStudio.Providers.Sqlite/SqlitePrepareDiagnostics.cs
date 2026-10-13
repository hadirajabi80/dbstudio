using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Sql;
using Microsoft.Data.Sqlite;

namespace DbStudio.Providers.Sqlite;

/// <summary>
/// Syntax/semantic diagnostics by compiling statements with <c>sqlite3_prepare</c> (docs/PLAN.md 2.5, 4.11).
/// Nothing runs against the user's database: the schema of the profile's database (and attachments) is replayed into a
/// private in-memory database, then each statement of the document is prepared there. DDL statements of the
/// document are executed on that copy so later statements see the tables they create.
/// Without a profile only syntax-level errors are reported ("no such table" would be noise).
/// </summary>
public sealed class SqlitePrepareDiagnostics : ISqlDiagnostics
{
    private const int MaxStatements = 2000;

    public string EngineName => "sqlite-prepare";

    public async Task<IReadOnlyList<SqlDiagnostic>> AnalyzeAsync(string sql, ConnectionProfile? profile, string? password, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sql)) return [];
        return await Task.Run(() => Analyze(sql, profile, ct), ct).ConfigureAwait(false);
    }

    private static List<SqlDiagnostic> Analyze(string sql, ConnectionProfile? profile, CancellationToken ct)
    {
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.Sqlite);
        var statements = SqlTokenizer.SplitStatements(tokens, Dialect.Sqlite);
        var diagnostics = new List<SqlDiagnostic>();
        if (statements.Count == 0) return diagnostics;

        using var scratch = new SqliteConnection("Data Source=:memory:");
        scratch.Open();
        var hasSchema = profile is not null && TryReplaySchema(profile, scratch, ct);

        foreach (var st in statements.Take(MaxStatements))
        {
            ct.ThrowIfCancellationRequested();
            var start = st[0].Start;
            var end = st[^1].End;
            var text = sql[start..end];
            var classification = StatementClassifier.Classify(text, Dialect.Sqlite).Statements.FirstOrDefault();
            try
            {
                using var cmd = scratch.CreateCommand();
                cmd.CommandText = text;
                if (classification?.Category == StatementCategory.Ddl && classification.Kind is not ("ATTACH" or "DETACH"))
                {
                    // Execute DDL on the private copy so later statements resolve the objects it creates/drops.
                    cmd.ExecuteNonQuery();
                }
                else if (classification?.Kind is "ATTACH" or "DETACH")
                {
                    continue;
                }
                else
                {
                    cmd.Prepare();
                }
            }
            catch (SqliteException ex)
            {
                var message = SqliteNames.CleanMessage(ex.Message);
                if (!hasSchema && IsSchemaDependent(message)) continue;
                var local = SqliteErrorLocator.Locate(message, text);
                int from, to;
                if (local is { } off)
                {
                    from = start + off;
                    var tok = st.FirstOrDefault(t => t.Start == from);
                    to = tok.End > from ? tok.End : Math.Min(end, from + 1);
                }
                else
                {
                    from = start;
                    to = end;
                }
                var (line, col) = SqlTokenizer.LineColAt(sql, from);
                var (endLine, endCol) = SqlTokenizer.LineColAt(sql, to);
                diagnostics.Add(new SqlDiagnostic(line, col, endLine, endCol, "error", SqliteNames.CodeName(ex.SqliteErrorCode), message));
            }
            catch (InvalidOperationException)
            {
                // e.g. "Must add values for the following parameters" when executing parameterised DDL: not a SQL error.
            }
        }
        return diagnostics;
    }

    private static bool IsSchemaDependent(string message) =>
        message.StartsWith("no such table", StringComparison.Ordinal) || message.StartsWith("no such column", StringComparison.Ordinal)
        || message.StartsWith("no such view", StringComparison.Ordinal) || message.StartsWith("no such index", StringComparison.Ordinal)
        || message.StartsWith("no such trigger", StringComparison.Ordinal) || message.Contains("has no column named", StringComparison.Ordinal);

    /// <summary>Copies the schema (tables, views, indexes, triggers) of the profile's databases into <paramref name="scratch"/>.</summary>
    private static bool TryReplaySchema(ConnectionProfile profile, SqliteConnection scratch, CancellationToken ct)
    {
        var path = SqliteConnections.ResolvePath(profile);
        if (path.Length == 0 || (path != SqliteConnections.MemoryPath && !File.Exists(path))) return false;
        try
        {
            using var source = SqliteConnections.OpenAsync(profile, forceReadOnly: true, ct).GetAwaiter().GetResult();
            var databases = new List<string>();
            using (var cmd = source.CreateCommand())
            {
                cmd.CommandText = "PRAGMA database_list";
                using var r = cmd.ExecuteReader();
                while (r.Read())
                {
                    var name = r.GetString(1);
                    if (!name.Equals("temp", StringComparison.OrdinalIgnoreCase)) databases.Add(name);
                }
            }

            foreach (var db in databases)
            {
                if (!db.Equals("main", StringComparison.OrdinalIgnoreCase))
                {
                    using var attach = scratch.CreateCommand();
                    attach.CommandText = $"ATTACH DATABASE ':memory:' AS {SqliteNames.Quote(db)}";
                    attach.ExecuteNonQuery();
                }

                var objects = new List<string>();
                using (var cmd = source.CreateCommand())
                {
                    cmd.CommandText = $"SELECT sql FROM {SqliteNames.Quote(db)}.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' " +
                                      "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'index' THEN 2 ELSE 3 END, rowid";
                    using var r = cmd.ExecuteReader();
                    while (r.Read()) objects.Add(r.GetString(0));
                }

                foreach (var ddl in objects)
                {
                    ct.ThrowIfCancellationRequested();
                    try
                    {
                        using var create = scratch.CreateCommand();
                        create.CommandText = db.Equals("main", StringComparison.OrdinalIgnoreCase) ? ddl : QualifyCreate(ddl, db);
                        create.ExecuteNonQuery();
                    }
                    catch (SqliteException)
                    {
                        // Shadow tables of virtual tables already exist, unknown modules, etc.: skip.
                    }
                }
            }
            return true;
        }
        catch (Exception ex) when (ex is SqliteException or IOException or ArgumentException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Inserts a schema qualifier before the object name of a CREATE statement.</summary>
    internal static string QualifyCreate(string ddl, string schema)
    {
        var tokens = SqlTokenizer.Tokenize(ddl, Dialect.Sqlite);
        var i = 0;
        if (i < tokens.Count && tokens[i].IsWord("CREATE")) i++;
        while (i < tokens.Count && tokens[i].Kind == SqlTokenKind.Word && tokens[i].Upper is "TEMP" or "TEMPORARY" or "UNIQUE" or "VIRTUAL") i++;
        if (i < tokens.Count && tokens[i].Kind == SqlTokenKind.Word) i++; // TABLE | VIEW | INDEX | TRIGGER
        if (i + 2 < tokens.Count && tokens[i].IsWord("IF") && tokens[i + 1].IsWord("NOT") && tokens[i + 2].IsWord("EXISTS")) i += 3;
        if (i >= tokens.Count || !tokens[i].IsIdentifier) return ddl;
        if (i + 1 < tokens.Count && tokens[i + 1].IsPunct('.')) return ddl; // already qualified
        var at = tokens[i].Start;
        return ddl[..at] + SqliteNames.Quote(schema) + "." + ddl[at..];
    }
}
