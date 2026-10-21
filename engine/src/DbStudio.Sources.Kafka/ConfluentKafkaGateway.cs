using Confluent.Kafka;
using Confluent.Kafka.Admin;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// <see cref="IKafkaGateway"/> over Confluent.Kafka / librdkafka: one shared <see cref="IAdminClient"/> per connection
/// (D2), one cached producer per compression codec (acks=all), and short-lived manually assigned consumers for browsing and
/// tailing (random <c>group.id</c>, never subscribes, never commits). librdkafka log and error callbacks go to the
/// connection's <see cref="KafkaLogBuffer"/>.
/// </summary>
public sealed class ConfluentKafkaGateway : IKafkaGateway
{
    private readonly KafkaSettings _settings;
    private readonly KafkaLogBuffer _log;
    private readonly IAdminClient _admin;
    private readonly Dictionary<string, IProducer<byte[], byte[]>> _producers = new(StringComparer.Ordinal);
    private readonly object _producerGate = new();
    private bool _disposed;

    public ConfluentKafkaGateway(KafkaSettings settings, KafkaLogBuffer log)
    {
        KafkaNative.EnsureLoaded();
        _settings = settings;
        _log = log;
        _admin = new AdminClientBuilder(settings.ToClientConfig())
            .SetLogHandler((_, m) => _log.Add(KafkaLogBuffer.MapLevel((int)m.Level), m.Facility, m.Name, m.Message))
            .SetErrorHandler((_, e) => _log.Add("error", e.IsFatal ? "FATAL" : "ERROR", "admin", e.Reason))
            .Build();
    }

    /// <summary>librdkafka version; touching it loads the native library (docs/PLAN-M2.md D8).</summary>
    public static string NativeVersion => KafkaNative.Version;

    public string LibraryVersion => KafkaNative.Version;

    private TimeSpan Timeout => TimeSpan.FromMilliseconds(_settings.RequestTimeoutMs);

    public Task<KMetadata> MetadataAsync(string? topic, CancellationToken ct) => Run(() =>
    {
        var md = topic is null ? _admin.GetMetadata(Timeout) : _admin.GetMetadata(topic, Timeout);
        var topics = md.Topics.Select(t => new KTopicMeta(t.Topic,
            t.Partitions.OrderBy(p => p.PartitionId).Select(p => new KPartitionMeta(p.PartitionId, p.Leader, p.Replicas, p.InSyncReplicas,
                p.Error.IsError ? p.Error.Reason : null)).ToList(),
            t.Topic.StartsWith("__", StringComparison.Ordinal) || t.Topic.StartsWith("_confluent", StringComparison.Ordinal) || t.Topic == "_schemas",
            t.Error.IsError ? t.Error.Code == ErrorCode.UnknownTopicOrPart ? "unknown" : t.Error.Reason : null)).ToList();
        if (topic is not null && topics.FirstOrDefault(t => t.Name == topic) is { Error: "unknown" })
            throw new KafkaGatewayException(KafkaErrorKind.UnknownTopic, $"Topic '{topic}' does not exist.");
        return new KMetadata(md.Brokers.Select(b => new KBroker(b.BrokerId, b.Host, b.Port, null)).ToList(), topics, md.OriginatingBrokerId);
    }, ct);

    public Task<KClusterInfo> DescribeClusterAsync(CancellationToken ct) => Run(async () =>
    {
        var r = await _admin.DescribeClusterAsync(new DescribeClusterOptions { RequestTimeout = Timeout }).ConfigureAwait(false);
        return new KClusterInfo(r.ClusterId, r.Controller?.Id, r.Nodes.Select(n => new KBroker(n.Id, n.Host, n.Port, n.Rack)).ToList());
    }, ct);

    public Task<IReadOnlyList<KConfigEntry>> DescribeConfigsAsync(KConfigResource kind, string name, CancellationToken ct) => Run(async () =>
    {
        var resource = new ConfigResource { Type = kind == KConfigResource.Topic ? ResourceType.Topic : ResourceType.Broker, Name = name };
        var results = await _admin.DescribeConfigsAsync([resource], new DescribeConfigsOptions { RequestTimeout = Timeout })
            .ConfigureAwait(false);
        return (IReadOnlyList<KConfigEntry>)results.SelectMany(r => r.Entries.Values).OrderBy(e => e.Name, StringComparer.Ordinal)
            .Select(e => new KConfigEntry(e.Name, e.IsSensitive ? null : e.Value, Source(e.Source), e.IsDefault, e.IsReadOnly, e.IsSensitive,
                (e.Synonyms ?? []).Select(s => new KConfigSynonym(s.Name, e.IsSensitive ? null : s.Value, Source(s.Source))).ToList()))
            .ToList();
    }, ct);

    public Task CreateTopicAsync(string name, int partitions, short replicationFactor, IReadOnlyDictionary<string, string> configs, CancellationToken ct) =>
        Run(() => _admin.CreateTopicsAsync([new TopicSpecification
        {
            Name = name, NumPartitions = partitions, ReplicationFactor = replicationFactor,
            Configs = configs.ToDictionary(kv => kv.Key, kv => kv.Value),
        }], new CreateTopicsOptions { RequestTimeout = Timeout, OperationTimeout = Timeout }), ct);

    public Task DeleteTopicAsync(string name, CancellationToken ct) =>
        Run(() => _admin.DeleteTopicsAsync([name], new DeleteTopicsOptions { RequestTimeout = Timeout, OperationTimeout = Timeout }), ct);

    public Task CreatePartitionsAsync(string topic, int totalCount, CancellationToken ct) =>
        Run(() => _admin.CreatePartitionsAsync([new PartitionsSpecification { Topic = topic, IncreaseTo = totalCount }],
            new CreatePartitionsOptions { RequestTimeout = Timeout, OperationTimeout = Timeout }), ct);

    public Task AlterTopicConfigsAsync(string topic, IReadOnlyDictionary<string, string> set, IReadOnlyList<string> delete, CancellationToken ct) =>
        Run(() =>
        {
            var entries = set.Select(kv => new ConfigEntry { Name = kv.Key, Value = kv.Value, IncrementalOperation = AlterConfigOpType.Set })
                .Concat(delete.Select(n => new ConfigEntry { Name = n, Value = "", IncrementalOperation = AlterConfigOpType.Delete })).ToList();
            return _admin.IncrementalAlterConfigsAsync(
                new Dictionary<ConfigResource, List<ConfigEntry>> { [new ConfigResource { Type = ResourceType.Topic, Name = topic }] = entries },
                new IncrementalAlterConfigsOptions { RequestTimeout = Timeout });
        }, ct);

    public Task<IReadOnlyDictionary<int, long>> DeleteRecordsAsync(string topic, IReadOnlyDictionary<int, long> before, CancellationToken ct) => Run(async () =>
    {
        var r = await _admin.DeleteRecordsAsync(before.Select(kv => new TopicPartitionOffset(topic, kv.Key, kv.Value)),
            new DeleteRecordsOptions { RequestTimeout = Timeout, OperationTimeout = Timeout }).ConfigureAwait(false);
        return (IReadOnlyDictionary<int, long>)r.ToDictionary(x => x.Partition.Value, x => x.Offset.Value);
    }, ct);

    public Task<IReadOnlyDictionary<KTopicPartition, KWatermarks>> WatermarksAsync(IReadOnlyList<KTopicPartition> partitions, CancellationToken ct) => Run(async () =>
    {
        var result = new Dictionary<KTopicPartition, KWatermarks>();
        if (partitions.Count == 0) return (IReadOnlyDictionary<KTopicPartition, KWatermarks>)result;
        var tps = partitions.Select(p => new TopicPartition(p.Topic, p.Partition)).ToList();
        var opts = new ListOffsetsOptions { RequestTimeout = Timeout };
        var low = await _admin.ListOffsetsAsync(tps.Select(tp => new TopicPartitionOffsetSpec { TopicPartition = tp, OffsetSpec = OffsetSpec.Earliest() }), opts).ConfigureAwait(false);
        var high = await _admin.ListOffsetsAsync(tps.Select(tp => new TopicPartitionOffsetSpec { TopicPartition = tp, OffsetSpec = OffsetSpec.Latest() }), opts).ConfigureAwait(false);
        var highs = high.ResultInfos.ToDictionary(i => new KTopicPartition(i.TopicPartitionOffsetError.Topic, i.TopicPartitionOffsetError.Partition.Value),
            i => i.TopicPartitionOffsetError.Offset.Value);
        foreach (var i in low.ResultInfos)
        {
            var tp = new KTopicPartition(i.TopicPartitionOffsetError.Topic, i.TopicPartitionOffsetError.Partition.Value);
            var l = Math.Max(0, i.TopicPartitionOffsetError.Offset.Value);
            result[tp] = new KWatermarks(l, Math.Max(l, highs.GetValueOrDefault(tp, l)));
        }
        return result;
    }, ct);

    public Task<IReadOnlyDictionary<KTopicPartition, long?>> OffsetsForTimesAsync(IReadOnlyList<KTopicPartition> partitions, DateTimeOffset timestamp, CancellationToken ct) =>
        Run(async () =>
        {
            var ms = timestamp.ToUnixTimeMilliseconds();
            var r = await _admin.ListOffsetsAsync(partitions.Select(p => new TopicPartitionOffsetSpec
            {
                TopicPartition = new TopicPartition(p.Topic, p.Partition), OffsetSpec = OffsetSpec.ForTimestamp(ms),
            }), new ListOffsetsOptions { RequestTimeout = Timeout }).ConfigureAwait(false);
            return (IReadOnlyDictionary<KTopicPartition, long?>)r.ResultInfos.ToDictionary(
                i => new KTopicPartition(i.TopicPartitionOffsetError.Topic, i.TopicPartitionOffsetError.Partition.Value),
                i => i.TopicPartitionOffsetError.Offset.Value >= 0 ? i.TopicPartitionOffsetError.Offset.Value : (long?)null);
        }, ct);

    public IKafkaReader CreateReader(string purpose)
    {
        var config = _settings.ToClientConfig();
        config["group.id"] = $"dbstudio-{purpose}-{Guid.NewGuid():N}";
        config["enable.auto.commit"] = "false";
        config["enable.auto.offset.store"] = "false";
        config["enable.partition.eof"] = "true";
        config["auto.offset.reset"] = "earliest";
        config["fetch.max.bytes"] = (16 * 1024 * 1024).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var consumer = new ConsumerBuilder<byte[], byte[]>(config)
            .SetLogHandler((_, m) => _log.Add(KafkaLogBuffer.MapLevel((int)m.Level), m.Facility, m.Name, m.Message))
            .SetErrorHandler((_, e) => _log.Add("error", "ERROR", purpose, e.Reason))
            .Build();
        return new Reader(consumer);
    }

    public Task<IReadOnlyList<KDelivery>> ProduceAsync(string topic, IReadOnlyList<KProduceRecord> records, string? compression, CancellationToken ct) => Run(async () =>
    {
        var producer = Producer(compression ?? "none");
        var tasks = records.Select(r =>
        {
            var msg = new Message<byte[], byte[]> { Key = r.Key!, Value = r.Value! };
            if (r.Headers.Count > 0)
            {
                msg.Headers = [];
                foreach (var h in r.Headers) msg.Headers.Add(h.Key, h.Value);
            }
            return r.Partition is { } p
                ? producer.ProduceAsync(new TopicPartition(topic, p), msg, ct)
                : producer.ProduceAsync(topic, msg, ct);
        }).ToList();
        producer.Flush(TimeSpan.FromSeconds(10));
        var results = await Task.WhenAll(tasks).ConfigureAwait(false);
        return (IReadOnlyList<KDelivery>)results.Select(d => new KDelivery(d.Partition.Value, d.Offset.Value,
            DateTimeOffset.FromUnixTimeMilliseconds(d.Timestamp.UnixTimestampMs))).ToList();
    }, ct);

    public Task<IReadOnlyList<KGroupListing>> ListGroupsAsync(CancellationToken ct) => Run(async () =>
    {
        var r = await _admin.ListConsumerGroupsAsync(new ListConsumerGroupsOptions { RequestTimeout = Timeout }).ConfigureAwait(false);
        return (IReadOnlyList<KGroupListing>)r.Valid.Select(g => new KGroupListing(g.GroupId, g.State.ToString(), g.IsSimpleConsumerGroup)).ToList();
    }, ct);

    public Task<IReadOnlyList<KGroupDescription>> DescribeGroupsAsync(IReadOnlyList<string> groupIds, CancellationToken ct) => Run(async () =>
    {
        if (groupIds.Count == 0) return (IReadOnlyList<KGroupDescription>)[];
        var r = await _admin.DescribeConsumerGroupsAsync(groupIds, new DescribeConsumerGroupsOptions { RequestTimeout = Timeout }).ConfigureAwait(false);
        return (IReadOnlyList<KGroupDescription>)r.ConsumerGroupDescriptions.Select(g => new KGroupDescription(g.GroupId, g.State.ToString(),
            string.IsNullOrEmpty(g.PartitionAssignor) ? null : g.PartitionAssignor,
            g.Coordinator is { } c ? new KBroker(c.Id, c.Host, c.Port, c.Rack) : null,
            g.Members.Select(m => new KGroupMember(m.ConsumerId, m.ClientId, m.Host,
                (m.Assignment?.TopicPartitions ?? []).Select(tp => new KTopicPartition(tp.Topic, tp.Partition.Value)).ToList())).ToList())).ToList();
    }, ct);

    public Task<IReadOnlyList<KCommitted>> GroupOffsetsAsync(string groupId, CancellationToken ct) => Run(async () =>
    {
        var r = await _admin.ListConsumerGroupOffsetsAsync([new ConsumerGroupTopicPartitions(groupId, null)],
            new ListConsumerGroupOffsetsOptions { RequestTimeout = Timeout }).ConfigureAwait(false);
        return (IReadOnlyList<KCommitted>)r.SelectMany(g => g.Partitions).Select(p => new KCommitted(new KTopicPartition(p.Topic, p.Partition.Value),
            p.Offset.Value >= 0 ? p.Offset.Value : null)).ToList();
    }, ct);

    public Task AlterGroupOffsetsAsync(string groupId, IReadOnlyDictionary<KTopicPartition, long> offsets, CancellationToken ct) =>
        Run(() => _admin.AlterConsumerGroupOffsetsAsync([new ConsumerGroupTopicPartitionOffsets(groupId,
                offsets.Select(kv => new TopicPartitionOffset(kv.Key.Topic, kv.Key.Partition, kv.Value)).ToList())],
            new AlterConsumerGroupOffsetsOptions { RequestTimeout = Timeout }), ct);

    public Task DeleteGroupAsync(string groupId, CancellationToken ct) =>
        Run(() => _admin.DeleteGroupsAsync([groupId], new DeleteGroupsOptions { RequestTimeout = Timeout }), ct);

    private IProducer<byte[], byte[]> Producer(string compression)
    {
        lock (_producerGate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (_producers.TryGetValue(compression, out var p)) return p;
            var config = _settings.ToClientConfig();
            config["acks"] = "all";
            config["enable.idempotence"] = "false";
            config["compression.type"] = compression;
            config["message.timeout.ms"] = Math.Max(_settings.RequestTimeoutMs, 10_000).ToString(System.Globalization.CultureInfo.InvariantCulture);
            p = new ProducerBuilder<byte[], byte[]>(config)
                .SetLogHandler((_, m) => _log.Add(KafkaLogBuffer.MapLevel((int)m.Level), m.Facility, m.Name, m.Message))
                .SetErrorHandler((_, e) => _log.Add("error", "ERROR", "producer", e.Reason))
                .Build();
            _producers[compression] = p;
            return p;
        }
    }

    private static string Source(ConfigSource s) => s switch
    {
        ConfigSource.DynamicTopicConfig => "dynamic_topic_config",
        ConfigSource.DynamicBrokerConfig => "dynamic_broker_config",
        ConfigSource.DynamicDefaultBrokerConfig => "dynamic_default_broker_config",
        ConfigSource.StaticBrokerConfig => "static_broker_config",
        ConfigSource.DefaultConfig => "default_config",
        _ => "unknown",
    };

    /// <summary>Attempts of a call that fails with a transient group-coordinator error (see <see cref="IsTransient"/>).</summary>
    internal const int TransientAttempts = 6;

    private static async Task<T> Run<T>(Func<Task<T>> op, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { return await Task.Run(op, ct).WaitAsync(ct).ConfigureAwait(false); }
            catch (KafkaException ex) when (attempt < TransientAttempts && IsTransient(ex)) { await Backoff(attempt, ct).ConfigureAwait(false); }
            catch (KafkaException ex) { throw Translate(ex); }
        }
    }

    private static Task<T> Run<T>(Func<T> op, CancellationToken ct) => Run(() => Task.FromResult(op()), ct);

    private static Task Run(Func<Task> op, CancellationToken ct) => Run(async () => { await op().ConfigureAwait(false); return true; }, ct);

    private static Task Backoff(int attempt, CancellationToken ct) => Task.Delay(TimeSpan.FromMilliseconds(150 * attempt), ct);

    /// <summary>
    /// Group-coordinator errors a broker answers while a group's coordinator moves or loads its offsets (right after a
    /// group is created, on a fresh or restarted broker): NOT_COORDINATOR, COORDINATOR_NOT_AVAILABLE,
    /// COORDINATOR_LOAD_IN_PROGRESS. Kafka clients retry them; the admin API surfaces them, so the gateway retries with
    /// a short backoff before reporting an error.
    /// </summary>
    internal static bool IsTransient(KafkaException ex) => IsTransient(EffectiveError(ex).Code);

    internal static bool IsTransient(ErrorCode code) =>
        code is ErrorCode.NotCoordinatorForGroup or ErrorCode.GroupCoordinatorNotAvailable or ErrorCode.GroupLoadInProgress;

    /// <summary>The most specific error of a KafkaException (the first failed result of an admin *Exception).</summary>
    internal static Error EffectiveError(KafkaException ex) => ex switch
    {
        CreateTopicsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        DeleteTopicsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        CreatePartitionsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        DeleteRecordsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        DescribeConfigsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        IncrementalAlterConfigsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        DeleteGroupsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        AlterConsumerGroupOffsetsException e => e.Results.SelectMany(r => r.Partitions.Select(p => p.Error).Prepend(r.Error)).FirstOrDefault(x => x.IsError),
        ListConsumerGroupOffsetsException e => e.Results.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        DescribeConsumerGroupsException e => e.Results.ConsumerGroupDescriptions.Select(r => r.Error).FirstOrDefault(x => x.IsError),
        _ => null,
    } ?? ex.Error;

    /// <summary>KafkaException (and the admin *Exception result lists) to a gateway error with the most specific code.</summary>
    internal static KafkaGatewayException Translate(KafkaException ex)
    {
        var error = EffectiveError(ex);
        var kind = error.Code switch
        {
            ErrorCode.Local_Transport or ErrorCode.Local_AllBrokersDown or ErrorCode.BrokerNotAvailable or ErrorCode.Local_Resolve => KafkaErrorKind.Unreachable,
            ErrorCode.Local_TimedOut or ErrorCode.RequestTimedOut or ErrorCode.Local_MsgTimedOut => KafkaErrorKind.Timeout,
            ErrorCode.UnknownTopicOrPart or ErrorCode.Local_UnknownTopic or ErrorCode.Local_UnknownPartition => KafkaErrorKind.UnknownTopic,
            ErrorCode.TopicAlreadyExists => KafkaErrorKind.TopicExists,
            ErrorCode.GroupIdNotFound => KafkaErrorKind.UnknownGroup,
            ErrorCode.NonEmptyGroup or ErrorCode.UnknownMemberId or ErrorCode.RebalanceInProgress => KafkaErrorKind.GroupNotEmpty,
            ErrorCode.TopicAuthorizationFailed or ErrorCode.GroupAuthorizationFailed or ErrorCode.ClusterAuthorizationFailed
                or ErrorCode.TransactionalIdAuthorizationFailed or ErrorCode.DelegationTokenAuthorizationFailed => KafkaErrorKind.Authorization,
            ErrorCode.SaslAuthenticationFailed or ErrorCode.Local_Authentication => KafkaErrorKind.Authentication,
            ErrorCode.PolicyViolation => KafkaErrorKind.PolicyViolation,
            ErrorCode.InvalidPartitions or ErrorCode.InvalidReplicationFactor or ErrorCode.InvalidConfig or ErrorCode.InvalidRequest
                or ErrorCode.TopicException or ErrorCode.Local_InvalidArg or ErrorCode.InvalidReplicaAssignment or ErrorCode.OffsetOutOfRange => KafkaErrorKind.InvalidRequest,
            _ => KafkaErrorKind.Unknown,
        };
        return new KafkaGatewayException(kind, error.Reason, ex);
    }

    public void Dispose()
    {
        List<IProducer<byte[], byte[]>> producers;
        lock (_producerGate)
        {
            if (_disposed) return;
            _disposed = true;
            producers = [.. _producers.Values];
            _producers.Clear();
        }
        foreach (var p in producers)
        {
            try { p.Flush(TimeSpan.FromSeconds(2)); } catch (Exception) { /* closing anyway */ }
            p.Dispose();
        }
        _admin.Dispose();
    }

    private sealed class Reader(IConsumer<byte[], byte[]> consumer) : IKafkaReader
    {
        public void Assign(IReadOnlyList<(KTopicPartition Tp, long Offset)> start)
        {
            try { consumer.Assign(start.Select(s => new TopicPartitionOffset(s.Tp.Topic, s.Tp.Partition, s.Offset < 0 ? Offset.End : new Offset(s.Offset)))); }
            catch (KafkaException ex) { throw Translate(ex); }
        }

        public KConsumeResult? Consume(TimeSpan timeout, CancellationToken ct)
        {
            ConsumeResult<byte[], byte[]>? r;
            try { r = consumer.Consume(timeout); }
            catch (ConsumeException ex) when (ex.Error.Code is ErrorCode.Local_KeyDeserialization or ErrorCode.Local_ValueDeserialization) { return null; }
            catch (KafkaException ex) { throw Translate(ex); }
            ct.ThrowIfCancellationRequested();
            if (r is null) return null;
            if (r.IsPartitionEOF) return new KConsumeResult(null, new KTopicPartition(r.Topic, r.Partition.Value), r.Offset.Value);
            var m = r.Message;
            var headers = m.Headers is null ? (IReadOnlyList<KHeader>)[] : m.Headers.Select(h => new KHeader(h.Key, h.GetValueBytes())).ToList();
            var type = m.Timestamp.Type switch
            {
                TimestampType.CreateTime => "create",
                TimestampType.LogAppendTime => "logAppend",
                _ => "notAvailable",
            };
            return new KConsumeResult(new KRecord(r.Topic, r.Partition.Value, r.Offset.Value,
                DateTimeOffset.FromUnixTimeMilliseconds(m.Timestamp.UnixTimestampMs), type, m.Key, m.Value, headers));
        }

        public void Pause() => consumer.Pause(consumer.Assignment);

        public void Resume() => consumer.Resume(consumer.Assignment);

        public void Dispose()
        {
            try { consumer.Close(); } catch (Exception) { /* never joined a group */ }
            consumer.Dispose();
        }
    }
}
