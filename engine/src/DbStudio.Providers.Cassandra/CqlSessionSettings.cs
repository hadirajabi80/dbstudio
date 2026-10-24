using Cassandra;

namespace DbStudio.Providers.Cassandra;

/// <summary>Per-console settings (cqlsh CONSISTENCY / SERIAL CONSISTENCY / TRACING / PAGING), mutable and thread-safe.</summary>
public sealed class CqlSessionSettings
{
    private readonly object _lock = new();
    private ConsistencyLevel _consistency;
    private ConsistencyLevel _serial;
    private bool _tracing;
    private int _pageSize;
    private int? _insertTtl;

    public CqlSessionSettings(CqlConnectionSettings defaults)
    {
        _consistency = defaults.Consistency;
        _serial = defaults.SerialConsistency;
        _pageSize = defaults.PageSize;
    }

    public ConsistencyLevel Consistency { get { lock (_lock) return _consistency; } set { lock (_lock) _consistency = value; } }

    public ConsistencyLevel SerialConsistency
    {
        get { lock (_lock) return _serial; }
        set
        {
            if (value is not (ConsistencyLevel.Serial or ConsistencyLevel.LocalSerial))
                throw new ArgumentException("Serial consistency must be SERIAL or LOCAL_SERIAL.", nameof(value));
            lock (_lock) _serial = value;
        }
    }

    public bool Tracing { get { lock (_lock) return _tracing; } set { lock (_lock) _tracing = value; } }

    public int PageSize
    {
        get { lock (_lock) return _pageSize; }
        set { lock (_lock) _pageSize = Math.Clamp(value, 1, CqlConnectionSettings.MaxPageSize); }
    }

    /// <summary>TTL (seconds) added to data-grid INSERTs; null = none.</summary>
    public int? InsertTtl
    {
        get { lock (_lock) return _insertTtl; }
        set
        {
            if (value is < 0 or > 630_720_000) throw new ArgumentException("TTL must be between 0 and 630720000 seconds (20 years).", nameof(value));
            lock (_lock) _insertTtl = value is 0 ? null : value;
        }
    }
}

/// <summary>Wire shape of <c>GET /cassandra/sessions/{sid}/settings</c> (ui/src/api/types.cassandra.ts CqlSessionSettings).</summary>
public sealed record CqlSessionSettingsInfo(string Consistency, string SerialConsistency, bool Tracing, int PageSize, int? InsertTtl,
    string? Keyspace, string? LastTraceId);

/// <summary>One traced statement of a console (CqlTraceSummary).</summary>
public sealed record CqlTraceSummary(string TraceId, string StartedAt, string Statement, string? Coordinator, long? DurationMicros, string? Consistency);
