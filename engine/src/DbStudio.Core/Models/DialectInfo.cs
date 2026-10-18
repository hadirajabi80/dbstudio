namespace DbStudio.Core.Models;

/// <summary>
/// Dialect traits shared by Core switches (docs/PLAN-PG.md 1.1, committed by M2-0). PG-A replaces the
/// <c>== Dialect.TSql</c> database-level checks in Core with <see cref="HasDatabases"/>.
/// </summary>
public static class DialectInfo
{
    /// <summary>The dialect has a database level above schemas that a session can target (SQL Server, PostgreSQL).</summary>
    public static bool HasDatabases(Dialect d) => d is Dialect.TSql or Dialect.PgSql;

    /// <summary>Schema used when the server reports none.</summary>
    public static string DefaultSchemaFallback(Dialect d) => d switch
    {
        Dialect.TSql => "dbo",
        Dialect.PgSql => "public",
        Dialect.Sqlite => "main",
        _ => "",
    };

    /// <summary><c>/* /* */ */</c> nests (SQL Server, PostgreSQL).</summary>
    public static bool NestedBlockComments(Dialect d) => d is Dialect.TSql or Dialect.PgSql;
}
