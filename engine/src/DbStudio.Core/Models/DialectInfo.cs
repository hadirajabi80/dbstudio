namespace DbStudio.Core.Models;

/// <summary>
/// Dialect traits shared by Core switches (docs/PLAN-PG.md 1.1, committed by M2-0). PG-A replaces the
/// <c>== Dialect.TSql</c> database-level checks in Core with <see cref="HasDatabases"/>. Batch 3 (WP0) moved the lexer
/// traits here too (<see cref="Sql.SqlTokenizer"/> reads them), so a new dialect never edits the tokenizer.
/// </summary>
public static class DialectInfo
{
    /// <summary>The dialect has a database level above schemas that a session can target (SQL Server, PostgreSQL, Snowflake).</summary>
    public static bool HasDatabases(Dialect d) => d is Dialect.TSql or Dialect.PgSql or Dialect.Snowflake;

    /// <summary>
    /// Single-level dialects whose "schema" is a database/keyspace/user (Oracle, MySQL/MariaDB, ClickHouse, Cassandra):
    /// <c>ListSchemasAsync</c> lists databases and <c>ChangeDatabaseAsync</c> is <c>USE x</c>.
    /// </summary>
    public static bool SchemaIsDatabase(Dialect d) => d is Dialect.PlSql or Dialect.MySql or Dialect.ClickHouse or Dialect.Cql;

    /// <summary>Schema used when the server reports none.</summary>
    public static string DefaultSchemaFallback(Dialect d) => d switch
    {
        Dialect.TSql => "dbo",
        Dialect.PgSql => "public",
        Dialect.Sqlite => "main",
        Dialect.MySql => "",
        Dialect.ClickHouse => "default",
        Dialect.Snowflake => "PUBLIC",
        Dialect.Cql => "",
        _ => "",
    };

    /// <summary><c>/* /* */ */</c> nests (SQL Server, PostgreSQL).</summary>
    public static bool NestedBlockComments(Dialect d) => d is Dialect.TSql or Dialect.PgSql;

    /// <summary><c>`name`</c> is a quoted identifier (SQLite accepts it as an alternative; MySQL and ClickHouse use it).</summary>
    public static bool BacktickIdentifiers(Dialect d) => d is Dialect.Sqlite or Dialect.MySql or Dialect.ClickHouse;

    /// <summary><c># …</c> is a line comment (MySQL, ClickHouse).</summary>
    public static bool HashLineComments(Dialect d) => d is Dialect.MySql or Dialect.ClickHouse;

    /// <summary>A backslash escapes the next character inside <c>'…'</c> (doubled <c>''</c> still works).</summary>
    public static bool BackslashStringEscapes(Dialect d) => d is Dialect.MySql or Dialect.ClickHouse or Dialect.Snowflake;

    /// <summary><c>$$…$$</c> / <c>$tag$…$tag$</c> string bodies (PostgreSQL, Snowflake).</summary>
    public static bool DollarQuotedStrings(Dialect d) => d is Dialect.PgSql or Dialect.Snowflake;

    /// <summary>Open/close characters the engine uses to quote an identifier it generates.</summary>
    public static (char Open, char Close) IdentifierQuote(Dialect d) =>
        d is Dialect.TSql ? ('[', ']') : BacktickIdentifiers(d) && d != Dialect.Sqlite ? ('`', '`') : ('"', '"');

    /// <summary>Quotes <paramref name="name"/> with <see cref="IdentifierQuote"/>, doubling the closing character.</summary>
    public static string QuoteIdentifier(Dialect d, string name)
    {
        var (open, close) = IdentifierQuote(d);
        return open + name.Replace(close.ToString(), new string(close, 2), StringComparison.Ordinal) + close;
    }
}
