namespace DbStudio.Sources.Kafka;

/// <param name="Level">debug | info | warn | error (librdkafka syslog levels mapped).</param>
/// <param name="Facility">librdkafka facility (BROKER, FAIL, REQTMOUT...) or "ERROR" for error-callback events.</param>
public sealed record KafkaLogEntry(long Seq, DateTimeOffset Ts, string Level, string Facility, string Client, string Message);

/// <summary>
/// Bounded in-memory log of one connection's librdkafka clients (<c>SetLogHandler</c> / <c>SetErrorHandler</c>).
/// Exposed as <see cref="KafkaClientHandle.LogBuffer"/> for the Logs view (package M2-L, docs/PLAN-M2.md 7.5):
/// Kafka has no server log over the protocol, so the Logs view shows this client log.
/// </summary>
public sealed class KafkaLogBuffer(int capacity = 2000)
{
    private readonly Queue<KafkaLogEntry> _entries = new();
    private readonly object _gate = new();
    private long _seq;
    private long _evicted;

    /// <summary>Raised after an entry was added (outside the lock).</summary>
    public event Action<KafkaLogEntry>? Added;

    public int Capacity => capacity;

    /// <summary>Entries dropped because the buffer was full.</summary>
    public long Evicted => Interlocked.Read(ref _evicted);

    public void Add(string level, string facility, string client, string message)
    {
        KafkaLogEntry entry;
        lock (_gate)
        {
            entry = new KafkaLogEntry(++_seq, DateTimeOffset.UtcNow, level, facility, client, message);
            _entries.Enqueue(entry);
            while (_entries.Count > capacity)
            {
                _entries.Dequeue();
                _evicted++;
            }
        }
        Added?.Invoke(entry);
    }

    /// <summary>Entries with <c>Seq &gt; afterSeq</c>, oldest first.</summary>
    public IReadOnlyList<KafkaLogEntry> Snapshot(long afterSeq = 0)
    {
        lock (_gate) return _entries.Where(e => e.Seq > afterSeq).ToList();
    }

    /// <summary>The last error-level message (used to explain metadata timeouts: "Connect to ... failed: Connection refused").</summary>
    public KafkaLogEntry? LastError()
    {
        lock (_gate) return _entries.LastOrDefault(e => e.Level == "error");
    }

    /// <summary>librdkafka syslog level (0 emerg … 7 debug) to the Logs view levels.</summary>
    public static string MapLevel(int syslogLevel) => syslogLevel switch
    {
        <= 3 => "error",
        4 => "warn",
        5 or 6 => "info",
        _ => "debug",
    };
}
