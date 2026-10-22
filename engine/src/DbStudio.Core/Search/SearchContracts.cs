using DbStudio.Core.Models;
using DbStudio.Core.Providers;

namespace DbStudio.Core.Search;

// "Find in database" (Ctrl+Shift+F): object names, columns, code (view/routine/trigger definitions) and, opt-in, table
// contents over one or more relational connections. The providers only read candidates from their system catalogs (with
// a LIKE prefilter when the term allows one); the exact match (case, whole word, regex), snippets, limits and progress are
// done once in DatabaseSearchService, so every dialect behaves the same.

/// <summary>An object name (table, view, routine, trigger, sequence, synonym…) of one schema.</summary>
/// <param name="Type">One of <see cref="ObjectTypes"/>.</param>
public sealed record SearchNameRow(string Schema, string Name, string Type);

/// <summary>A column of a table or view.</summary>
public sealed record SearchColumnRow(string Schema, string Object, string ObjectType, string Column, string? DataType);

/// <summary>
/// Source text of a view, routine, trigger or package. <paramref name="FirstLine"/> is the line number of the first line of
/// <paramref name="Text"/> within the definition (Oracle ALL_SOURCE returns single lines; the others whole definitions).
/// </summary>
public sealed record SearchCodeRow(string Schema, string Name, string Type, string Text, int FirstLine = 1);

/// <summary>A generated, parameterized data query (identifiers quoted by <see cref="SearchSql"/>, the term bound as a parameter).</summary>
/// <param name="KeyColumns">Leading result columns: the table's primary key (rows are opened through it).</param>
/// <param name="TextColumns">Following result columns: the searched (text) columns, in order.</param>
public sealed record DataSearchQuery(string Sql, IReadOnlyList<(string Name, object? Value)> Parameters, IReadOnlyList<string> KeyColumns,
    IReadOnlyList<string> TextColumns);

/// <summary>
/// Read-only catalog and data access of one connection for the search (one physical connection, or one per database
/// on PostgreSQL). Implementations never write and never concatenate the term into SQL.
/// </summary>
public interface IDatabaseSearcher : IAsyncDisposable
{
    Dialect Dialect { get; }

    /// <summary>The provider's catalog reader on the same connection(s): databases, schemas and table columns for data search.</summary>
    ICatalogReader Catalog { get; }

    /// <summary>
    /// Databases searched when a target names none: every database the login can open minus the system ones; an empty list
    /// when the provider has no database level (Oracle, SQLite).
    /// </summary>
    Task<IReadOnlyList<string>> SearchDatabasesAsync(CancellationToken ct);

    /// <param name="like">Dialect LIKE pattern (<see cref="SearchSql.LikePattern"/>) or null to read every name (regex search).</param>
    Task<IReadOnlyList<SearchNameRow>> NamesAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct);

    Task<IReadOnlyList<SearchColumnRow>> ColumnsAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct);

    IAsyncEnumerable<SearchCodeRow> CodeAsync(string? database, string schema, string? like, bool matchCase, CancellationToken ct);

    /// <summary>Runs a <see cref="DataSearchQuery"/>; rows are the key columns followed by the text columns (values as read).</summary>
    IAsyncEnumerable<object?[]> QueryAsync(string? database, DataSearchQuery query, CancellationToken ct);
}

/// <summary>
/// Implemented by the relational <see cref="IDbProvider"/>s that support "Find in database" (resolved by a type test, so
/// <see cref="IDbProvider"/> stays frozen). The searcher is short-lived: dispose it.
/// </summary>
public interface IDatabaseSearchProvider
{
    Task<IDatabaseSearcher> OpenSearcherAsync(ConnectionProfile profile, string? password, CancellationToken ct);
}

// ---------------------------------------------------------------------------------------------- wire items (stream.data)

/// <summary>The object a hit belongs to.</summary>
public sealed record SearchObject(string Name, string Type);

/// <summary>A key column value of a data hit (the row is opened with an equality filter on these).</summary>
public sealed record SearchKeyValue(string Column, object? Value);

/// <summary>Base of the items of a <c>db.search</c> stream; <see cref="Kind"/> tells them apart.</summary>
public abstract record SearchItem(string Kind);

/// <summary>One match.</summary>
/// <param name="Match">name | column | code | data.</param>
/// <param name="Text">What matched: the object name, the column name, the source line, or the cell value (a snippet around the match).</param>
/// <param name="Ranges">[start, length] of each match within <paramref name="Text"/>.</param>
/// <param name="Line">Code: 1-based line within the definition.</param>
/// <param name="More">Code: further matching lines of the same object that were not sent.</param>
public sealed record SearchHit(
    string ConnectionId, string? Database, string? Schema, SearchObject Object, string Match, string Text, IReadOnlyList<int[]> Ranges,
    string? Column = null, string? DataType = null, int? Line = null, IReadOnlyList<SearchKeyValue>? Key = null, int More = 0)
    : SearchItem("hit");

/// <param name="Phase">names | columns | code | data.</param>
/// <param name="Done">Data: tables searched so far in <paramref name="Schema"/>; otherwise schemas searched in the database.</param>
public sealed record SearchProgress(string ConnectionId, string? Database, string? Schema, string Phase, int Done, int Total, string? Table = null)
    : SearchItem("progress");

/// <summary>A part of the search that failed or was skipped; the rest goes on.</summary>
public sealed record SearchError(string ConnectionId, string? Database, string? Schema, string Message, string? Table = null, bool Notice = false)
    : SearchItem("error");

/// <summary>Last item of a finished search (not sent when it was cancelled).</summary>
public sealed record SearchDone(int Hits, bool Truncated, long ElapsedMs, int Connections) : SearchItem("done");
