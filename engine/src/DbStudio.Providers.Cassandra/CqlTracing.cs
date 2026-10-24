using System.Globalization;
using Cassandra;
using DbStudio.Core.Services;

namespace DbStudio.Providers.Cassandra;

public sealed record CqlTraceEvent(string EventId, string Activity, string Source, long SourceElapsedMicros, string? Thread, string Timestamp);

public sealed record CqlTrace(string TraceId, string? Coordinator, string? Client, string? Request, string? Command, string? StartedAt,
    long? DurationMicros, IReadOnlyDictionary<string, string> Parameters, IReadOnlyList<CqlTraceEvent> Events);

/// <summary>Reads request traces from <c>system_traces.sessions</c> / <c>events</c> (TRACING ON, SHOW SESSION).</summary>
public static class CqlTracing
{
    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    /// <summary>The trace, or null when the coordinator has not written it (yet). Retries briefly while it is incomplete.</summary>
    public static async Task<CqlTrace?> ReadAsync(ISession session, Guid traceId, CancellationToken ct, int attempts = 5)
    {
        CqlTrace? trace = null;
        for (var i = 0; i < Math.Max(1, attempts); i++)
        {
            trace = await ReadOnceAsync(session, traceId, ct).ConfigureAwait(false);
            if (trace is not null && trace.DurationMicros is not null) return trace;
            if (i + 1 < attempts) await Task.Delay(TimeSpan.FromMilliseconds(100 * (i + 1)), ct).ConfigureAwait(false);
        }
        return trace;
    }

    private static async Task<CqlTrace?> ReadOnceAsync(ISession session, Guid traceId, CancellationToken ct)
    {
        var sessionRows = (await session.ExecuteAsync(new SimpleStatement("SELECT * FROM system_traces.sessions WHERE session_id = ?", traceId)
            .SetConsistencyLevel(ConsistencyLevel.One)).WaitAsync(ct).ConfigureAwait(false)).ToList();
        if (sessionRows.Count == 0) return null;
        var s = sessionRows[0];
        var eventRows = (await session.ExecuteAsync(new SimpleStatement("SELECT * FROM system_traces.events WHERE session_id = ?", traceId)
            .SetConsistencyLevel(ConsistencyLevel.One).SetPageSize(5000)).WaitAsync(ct).ConfigureAwait(false)).ToList();
        var events = eventRows.Select(r =>
        {
            var id = r.GetValue<object>("event_id");
            var guid = id is Guid g ? g : id is TimeUuid tu ? tu.ToGuid() : Guid.Empty;
            var when = guid == Guid.Empty ? (DateTimeOffset?)null : ((TimeUuid)guid).GetDate();
            return new CqlTraceEvent(
                guid.ToString("D"),
                CqlSchemaReader.Str(r, "activity") ?? "",
                CqlSchemaReader.Str(r, "source") ?? "",
                CqlSchemaReader.Long(r, "source_elapsed") ?? 0,
                CqlSchemaReader.Str(r, "thread"),
                when?.ToUniversalTime().ToString(ValueConverter.DateTimeOffsetFormat, Inv) ?? "");
        }).ToList();
        var started = CqlSchemaReader.Has(s, "started_at") && !s.IsNull("started_at") ? s.GetValue<DateTimeOffset>("started_at") : (DateTimeOffset?)null;
        return new CqlTrace(
            traceId.ToString("D"),
            CqlSchemaReader.Str(s, "coordinator"),
            CqlSchemaReader.Str(s, "client"),
            CqlSchemaReader.Str(s, "request"),
            CqlSchemaReader.Str(s, "command"),
            started?.ToUniversalTime().ToString(ValueConverter.DateTimeOffsetFormat, Inv),
            CqlSchemaReader.Long(s, "duration"),
            CqlSchemaReader.Map(s, "parameters"),
            events);
    }
}
