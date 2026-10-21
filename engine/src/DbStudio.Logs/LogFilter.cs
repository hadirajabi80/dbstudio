using DbStudio.Core.Services;

namespace DbStudio.Logs;

/// <summary>Validation and engine-side filtering shared by every source (server-side filters are only a pre-filter).</summary>
public static class LogFilter
{
    public const int DefaultLimit = 1000;
    public const int MaxLimit = 5000;
    public const int MaxQueryLength = 1000;

    /// <summary>Validates a query (400 VALIDATION naming the field) and returns it with the default limit applied.</summary>
    public static LogQuery Validate(LogQuery? query)
    {
        if (query is null) throw EngineException.Validation("A query body is required.");
        if (string.IsNullOrWhiteSpace(query.SourceId)) throw EngineException.Validation("sourceId is required.", new { field = "sourceId" });
        if (query.Limit is < 0 or > MaxLimit)
            throw EngineException.Validation($"limit must be between 1 and {MaxLimit}.", new { field = "limit" });
        if (query.From is { } f && query.To is { } t && f > t)
            throw EngineException.Validation("from must not be after to.", new { field = "from" });
        if (query.Q is { Length: > MaxQueryLength })
            throw EngineException.Validation($"q is longer than {MaxQueryLength} characters.", new { field = "q" });
        if (query.Archive is < 0 or > 99) throw EngineException.Validation("archive must be between 0 and 99.", new { field = "archive" });
        List<string>? levels = null;
        if (query.Levels is { Count: > 0 })
        {
            levels = [];
            foreach (var l in query.Levels)
            {
                var n = l?.Trim().ToLowerInvariant() ?? "";
                if (!LogLevels.IsKnown(n)) throw EngineException.Validation($"Unknown level '{l}'.", new { field = "levels" });
                if (!levels.Contains(n)) levels.Add(n);
            }
        }
        return query with
        {
            SourceId = query.SourceId.Trim(),
            Limit = query.Limit == 0 ? DefaultLimit : query.Limit,
            Q = string.IsNullOrWhiteSpace(query.Q) ? null : query.Q.Trim(),
            Levels = levels,
        };
    }

    public static int LimitOf(LogQuery q) => q.Limit <= 0 ? DefaultLimit : Math.Min(q.Limit, MaxLimit);

    /// <summary>True when the entry passes levels, time range, text and the seq cursors.</summary>
    public static bool Matches(LogEntry e, LogQuery q)
    {
        if (q.Before is { } before && e.Seq >= before) return false;
        if (q.After is { } after && e.Seq <= after) return false;
        if (!LogLevels.Matches(e.Level, q.Levels)) return false;
        if (q.From is not null || q.To is not null)
        {
            if (e.Time is { } t)
            {
                if (q.From is { } f && t < f) return false;
                if (q.To is { } to && t > to) return false;
            }
        }
        return q.Q is null || Contains(e, q.Q);
    }

    /// <summary>Case-insensitive substring over message, detail, source and field values.</summary>
    public static bool Contains(LogEntry e, string text)
    {
        const StringComparison c = StringComparison.OrdinalIgnoreCase;
        if (e.Message.Contains(text, c) || e.Source.Contains(text, c)) return true;
        if (e.Detail is not null && e.Detail.Contains(text, c)) return true;
        return e.Fields is not null && e.Fields.Values.Any(v => v.Contains(text, c));
    }

    /// <summary>
    /// Applies <see cref="Matches"/> to entries of any order and returns the newest <c>limit</c> ascending by seq.
    /// With an <c>after</c> cursor (tail) the OLDEST <c>limit</c> after the cursor are returned instead, so nothing is
    /// skipped between polls.
    /// </summary>
    public static LogQueryResponse Page(IEnumerable<LogEntry> entries, LogQuery q, bool truncated = false, bool sourceHasMore = false)
    {
        var limit = LimitOf(q);
        var matching = entries.Where(e => Matches(e, q)).OrderBy(e => e.Seq).ToList();
        if (q.After is not null)
        {
            var head = matching.Take(limit).ToList();
            return new LogQueryResponse(head, matching.Count > limit, truncated);
        }
        var hasMore = matching.Count > limit || sourceHasMore;
        var page = matching.Count > limit ? matching.GetRange(matching.Count - limit, limit) : matching;
        return new LogQueryResponse(page, hasMore, truncated);
    }
}
