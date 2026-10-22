using System.Diagnostics;
using System.Globalization;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace DbStudio.Core.Search;

/// <summary>Opens the searcher of a connection (tests hand in their own).</summary>
public delegate Task<IDatabaseSearcher> SearcherFactory(string connectionId, CancellationToken ct);

/// <summary>
/// Runs a <see cref="SearchRequest"/>: connections in parallel (at most <see cref="MaxParallelConnections"/>), inside a
/// connection database by database and schema by schema — names, columns and code first, then (opt-in) table data with a
/// per-table row limit and timeout. Every item is handed to <c>emit</c> as soon as it is known; a failing part is reported
/// as an error item and the rest goes on. Cancelling the token stops everything (in-flight commands are cancelled).
/// </summary>
public sealed class DatabaseSearchService
{
    public const int MaxParallelConnections = 4;
    /// <summary>Matching source lines sent per object; the rest is summed up in one "more" hit.</summary>
    public const int CodeLinesPerObject = 20;
    /// <summary>Tables a data search reads per schema.</summary>
    public const int MaxDataTablesPerSchema = 500;
    public static readonly TimeSpan DataTableTimeout = TimeSpan.FromSeconds(60);

    private static readonly HashSet<string> SystemDatabases = new(StringComparer.OrdinalIgnoreCase) { "master", "model", "msdb", "tempdb" };

    private readonly SearcherFactory _open;
    private readonly ILogger _log;

    public DatabaseSearchService(ConnectionStore connections, ProviderRegistry providers, ILogger<DatabaseSearchService>? log = null)
        : this(async (id, ct) =>
        {
            var profile = connections.Get(id);
            var provider = Searchable(providers, profile);
            return await provider.OpenSearcherAsync(profile, connections.GetPassword(id), ct).ConfigureAwait(false);
        }, log)
    {
        Connections = connections;
        Providers = providers;
    }

    public DatabaseSearchService(SearcherFactory open, ILogger<DatabaseSearchService>? log = null)
    {
        _open = open;
        _log = log ?? (ILogger)NullLogger.Instance;
    }

    private ConnectionStore? Connections { get; }
    private ProviderRegistry? Providers { get; }

    /// <summary>The search provider of a profile; 400 VALIDATION for sources that cannot be searched (Redis, MongoDB, Kafka).</summary>
    public static IDatabaseSearchProvider Searchable(ProviderRegistry providers, ConnectionProfile profile) =>
        providers.Find(profile.ProviderId) as IDatabaseSearchProvider
        ?? throw EngineException.Validation($"Connection '{profile.Name}' ({profile.ProviderId}) cannot be searched.", new { field = "params.targets" });

    /// <summary>404 for an unknown connection, 400 for one that cannot be searched (checked before the stream opens).</summary>
    public void Validate(SearchRequest request)
    {
        if (Connections is null || Providers is null) return;
        foreach (var id in request.Targets.Select(t => t.ConnectionId).Distinct(StringComparer.Ordinal))
            Searchable(Providers, Connections.Get(id));
    }

    private sealed class Run(SearchRequest request, Action<SearchItem> emit, CancellationTokenSource stop)
    {
        private int _hits;
        private volatile bool _truncated;
        private int _regexNotice;

        public SearchRequest Request { get; } = request;
        public SearchMatcher Matcher => Request.Matcher;
        public CancellationTokenSource Stop { get; } = stop;
        public int Hits => Math.Min(Volatile.Read(ref _hits), Request.MaxHits);
        public bool Truncated => _truncated;

        /// <summary>Progress, errors and "more" summaries; nothing once the hit limit stopped the search.</summary>
        public void Emit(SearchItem item)
        {
            if (!_truncated) emit(item);
        }

        /// <summary>Sends a hit unless the limit is reached (then the whole search stops, truncated).</summary>
        public void Hit(SearchHit hit)
        {
            var n = Interlocked.Increment(ref _hits);
            if (n > Request.MaxHits)
            {
                _truncated = true;
                try { Stop.Cancel(); } catch (ObjectDisposedException) { /* finished */ }
                return;
            }
            emit(hit);
        }

        /// <summary>True the first time (one "regex data search is not available" notice per search).</summary>
        public bool FirstRegexNotice() => Interlocked.Exchange(ref _regexNotice, 1) == 0;
    }

    public async Task RunAsync(SearchRequest request, Action<SearchItem> emit, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var run = new Run(request, emit, stop);
        var groups = request.Targets.GroupBy(t => t.ConnectionId, StringComparer.Ordinal).ToList();
        try
        {
            await Parallel.ForEachAsync(groups, new ParallelOptions { MaxDegreeOfParallelism = MaxParallelConnections, CancellationToken = stop.Token },
                async (g, gct) => await SearchConnectionAsync(run, g.Key, g.ToList(), gct).ConfigureAwait(false)).ConfigureAwait(false);
        }
        catch (Exception) when (stop.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            // The hit limit stopped the search (a driver may report its cancelled command with its own exception).
        }
        ct.ThrowIfCancellationRequested();
        emit(new SearchDone(run.Hits, run.Truncated, sw.ElapsedMilliseconds, groups.Count));
    }

    /// <summary>Once the search is cancelled any exception means "cancelled" (drivers throw their own on a cancelled command).</summary>
    private static bool Cancelled(Exception ex, CancellationToken ct) => ct.IsCancellationRequested;

    private async Task SearchConnectionAsync(Run run, string cid, List<SearchTarget> targets, CancellationToken ct)
    {
        IDatabaseSearcher searcher;
        try
        {
            searcher = await _open(cid, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (!Cancelled(ex, ct))
        {
            run.Emit(new SearchError(cid, null, null, $"Could not connect: {Describe(ex)}"));
            return;
        }
        await using (searcher.ConfigureAwait(false))
        {
            foreach (var target in targets)
            {
                ct.ThrowIfCancellationRequested();
                await SearchTargetAsync(run, searcher, target, ct).ConfigureAwait(false);
            }
        }
    }

    private async Task SearchTargetAsync(Run run, IDatabaseSearcher s, SearchTarget target, CancellationToken ct)
    {
        var cid = target.ConnectionId;
        var req = run.Request;
        IReadOnlyList<string?> databases;
        if (target.Database is not null) databases = [target.Database];
        else
        {
            try
            {
                var list = await s.SearchDatabasesAsync(ct).ConfigureAwait(false);
                databases = list.Count == 0 ? [null] : list.Where(d => !SystemDatabases.Contains(d)).Cast<string?>().ToList();
            }
            catch (Exception ex) when (!Cancelled(ex, ct))
            {
                run.Emit(new SearchError(cid, null, null, $"Could not list databases: {Describe(ex)}"));
                return;
            }
        }
        var scoped = target.Schema is not null || target.Objects is not null;
        if (req.Data && !scoped)
            run.Emit(new SearchError(cid, target.Database, null, "Table data is searched only in a chosen schema or chosen tables.", Notice: true));

        foreach (var db in databases)
        {
            ct.ThrowIfCancellationRequested();
            IReadOnlyList<string> schemas;
            if (target.Objects is { } objects) schemas = objects.Select(o => o.Schema ?? target.Schema).Where(x => x is not null).Select(x => x!).Distinct().ToList();
            else if (target.Schema is not null) schemas = [target.Schema];
            else
            {
                try
                {
                    schemas = (await s.Catalog.ListSchemasAsync(db, ct).ConfigureAwait(false)).Select(x => x.Name).ToList();
                }
                catch (Exception ex) when (!Cancelled(ex, ct))
                {
                    run.Emit(new SearchError(cid, db, null, $"Could not list schemas: {Describe(ex)}"));
                    continue;
                }
            }
            if (target.Objects is not null && schemas.Count == 0)
                schemas = [await s.Catalog.GetDefaultSchemaAsync(db, ct).ConfigureAwait(false)];

            Func<string, string, bool> inScope = target.Objects is { } objs
                ? (schema, name) => objs.Any(o => string.Equals(o.Name, name, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(o.Schema ?? schemas[0], schema, StringComparison.OrdinalIgnoreCase))
                : static (_, _) => true;

            if (req.Names || req.Columns || req.Code)
            {
                for (var i = 0; i < schemas.Count; i++)
                {
                    ct.ThrowIfCancellationRequested();
                    try
                    {
                        await SearchCatalogAsync(run, s, cid, db, schemas[i], inScope, i, schemas.Count, ct).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (!Cancelled(ex, ct))
                    {
                        run.Emit(new SearchError(cid, db, schemas[i], Describe(ex)));
                    }
                }
            }
            if (req.Data && scoped)
            {
                foreach (var schema in schemas)
                {
                    ct.ThrowIfCancellationRequested();
                    try
                    {
                        await SearchDataAsync(run, s, cid, db, schema, target.Objects, ct).ConfigureAwait(false);
                    }
                    catch (Exception ex) when (!Cancelled(ex, ct))
                    {
                        run.Emit(new SearchError(cid, db, schema, Describe(ex)));
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------ names, columns, code

    private static readonly HashSet<string> ColumnOwners = [ObjectTypes.Table, ObjectTypes.View, ObjectTypes.MView];

    private static async Task SearchCatalogAsync(Run run, IDatabaseSearcher s, string cid, string? db, string schema, Func<string, string, bool> inScope,
        int index, int count, CancellationToken ct)
    {
        var req = run.Request;
        var m = run.Matcher;
        var like = m.Literal is { } literal ? SearchSql.LikePattern(s.Dialect, literal) : null;

        if (req.Names)
        {
            run.Emit(new SearchProgress(cid, db, schema, "names", index, count));
            foreach (var r in await s.NamesAsync(db, schema, like, m.MatchCase, ct).ConfigureAwait(false))
            {
                if (!req.AllowsType(r.Type) || !inScope(r.Schema, r.Name)) continue;
                var ranges = m.Matches(r.Name);
                if (ranges.Count > 0) run.Hit(new SearchHit(cid, db, r.Schema, new SearchObject(r.Name, r.Type), "name", r.Name, ranges));
            }
        }

        if (req.Columns && (req.Types is null || req.Types.Overlaps(ColumnOwners)))
        {
            run.Emit(new SearchProgress(cid, db, schema, "columns", index, count));
            foreach (var r in await s.ColumnsAsync(db, schema, like, m.MatchCase, ct).ConfigureAwait(false))
            {
                if (!req.AllowsType(r.ObjectType) || !inScope(r.Schema, r.Object)) continue;
                var ranges = m.Matches(r.Column);
                if (ranges.Count > 0)
                    run.Hit(new SearchHit(cid, db, r.Schema, new SearchObject(r.Object, r.ObjectType), "column", r.Column, ranges, Column: r.Column, DataType: r.DataType));
            }
        }

        if (req.Code)
        {
            run.Emit(new SearchProgress(cid, db, schema, "code", index, count));
            var sent = new Dictionary<(string, string, string), int>();
            var more = new Dictionary<(string Schema, string Name, string Type), int>();
            await foreach (var r in s.CodeAsync(db, schema, like, m.MatchCase, ct).ConfigureAwait(false))
            {
                if (!req.AllowsType(r.Type) || !inScope(r.Schema, r.Name)) continue;
                var key = (r.Schema, r.Name, r.Type);
                var lines = r.Text.Split('\n');
                for (var i = 0; i < lines.Length; i++)
                {
                    var line = lines[i].TrimEnd('\r');
                    var ranges = m.Matches(line);
                    if (ranges.Count == 0) continue;
                    var n = sent.GetValueOrDefault(key);
                    if (n >= CodeLinesPerObject)
                    {
                        more[key] = more.GetValueOrDefault(key) + 1;
                        continue;
                    }
                    sent[key] = n + 1;
                    var (text, shifted) = SearchMatcher.Snippet(line, ranges);
                    run.Hit(new SearchHit(cid, db, r.Schema, new SearchObject(r.Name, r.Type), "code", text, shifted, Line: r.FirstLine + i));
                }
            }
            foreach (var (k, n) in more)
                run.Emit(new SearchHit(cid, db, k.Schema, new SearchObject(k.Name, k.Type), "code", "", [], More: n));
        }
    }

    // ------------------------------------------------------------------ data

    private static async Task SearchDataAsync(Run run, IDatabaseSearcher s, string cid, string? db, string schema, IReadOnlyList<ObjectRef>? objects,
        CancellationToken ct)
    {
        var req = run.Request;
        var catalog = await s.Catalog.LoadSchemaAsync(db, schema, ct).ConfigureAwait(false);
        var tables = catalog.Objects.Where(o =>
        {
            if (objects is not null)
                return objects.Any(x => string.Equals(x.Name, o.Name, StringComparison.OrdinalIgnoreCase)
                    && (x.Schema is null || string.Equals(x.Schema, schema, StringComparison.OrdinalIgnoreCase))) && ColumnOwners.Contains(o.Type);
            return o.Type == ObjectTypes.Table && req.AllowsType(o.Type);
        }).OrderBy(o => o.Name, StringComparer.OrdinalIgnoreCase).ToList();
        if (tables.Count > MaxDataTablesPerSchema)
        {
            run.Emit(new SearchError(cid, db, schema, $"Only the first {MaxDataTablesPerSchema} of {tables.Count} tables were searched for data.", Notice: true));
            tables = tables.Take(MaxDataTablesPerSchema).ToList();
        }

        if (run.Matcher.IsRegex && SearchSql.RegexPredicate(s.Dialect, "x", "@p", false) is null)
        {
            if (run.FirstRegexNotice())
                run.Emit(new SearchError(cid, db, schema, "This database has no regular expression operator, so table data was not searched. Turn off regex to search data.",
                    Notice: true));
            return;
        }

        for (var i = 0; i < tables.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var t = tables[i];
            run.Emit(new SearchProgress(cid, db, schema, "data", i, tables.Count, t.Name));
            var columns = t.Columns.Where(c => (c.Flags & 4) == 0).Select(c => (c.Name, (string?)c.TypeText)).ToList();
            var query = SearchSql.BuildDataQuery(s.Dialect, catalog.Name, t.Name, t.PrimaryKey, columns, run.Matcher, req.DataRowLimit);
            if (query is null) continue; // no text column
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(DataTableTimeout);
            try
            {
                await foreach (var row in s.QueryAsync(db, query, timeout.Token).ConfigureAwait(false))
                {
                    var key = query.KeyColumns.Count == 0 ? null
                        : query.KeyColumns.Select((k, j) => new SearchKeyValue(k, WireKey(row[j]))).ToList();
                    for (var j = 0; j < query.TextColumns.Count; j++)
                    {
                        var value = TextOf(row[query.KeyColumns.Count + j]);
                        var ranges = run.Matcher.Matches(value);
                        if (ranges.Count == 0) continue;
                        var (text, shifted) = SearchMatcher.Snippet(value!, ranges);
                        run.Hit(new SearchHit(cid, db, catalog.Name, new SearchObject(t.Name, t.Type), "data", text, shifted,
                            Column: query.TextColumns[j], DataType: t.Columns.FirstOrDefault(c => c.Name == query.TextColumns[j])?.TypeText, Key: key));
                    }
                }
            }
            catch (Exception ex) when (!Cancelled(ex, ct))
            {
                // A timed-out command may surface as the driver's own "cancelled" error.
                run.Emit(new SearchError(cid, db, schema,
                    timeout.IsCancellationRequested ? $"Timed out after {DataTableTimeout.TotalSeconds:0} s." : Describe(ex), t.Name));
            }
        }
        run.Emit(new SearchProgress(cid, db, schema, "data", tables.Count, tables.Count));
    }

    /// <summary>A cell as text (null for NULL and binaries).</summary>
    public static string? TextOf(object? v) => v switch
    {
        null or DBNull => null,
        string s => s,
        byte[] => null,
        char[] c => new string(c),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString(),
    };

    /// <summary>A key value as the UI filters on it: numbers (that fit a double exactly) stay numbers, everything else is text.</summary>
    public static object? WireKey(object? v) => v switch
    {
        null or DBNull => null,
        string s => s,
        bool b => b,
        byte or sbyte or short or ushort or int => Convert.ToInt64(v, CultureInfo.InvariantCulture),
        long l when Math.Abs(l) <= 9_007_199_254_740_991L => l,
        uint or ulong or long => Convert.ToString(v, CultureInfo.InvariantCulture),
        decimal d when d == Math.Truncate(d) && Math.Abs(d) <= 9_007_199_254_740_991m => (long)d,
        decimal d => d.ToString(CultureInfo.InvariantCulture),
        double or float => Convert.ToDouble(v, CultureInfo.InvariantCulture),
        DateTime dt => dt.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture).TrimEnd('.'),
        DateTimeOffset dto => dto.ToString("yyyy-MM-dd HH:mm:ss.FFFFFFFzzz", CultureInfo.InvariantCulture),
        Guid g => g.ToString(),
        byte[] => null,
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        _ => v.ToString(),
    };

    private static string Describe(Exception ex) => ex is AggregateException { InnerException: { } inner } ? Describe(inner) : ex.Message;
}
