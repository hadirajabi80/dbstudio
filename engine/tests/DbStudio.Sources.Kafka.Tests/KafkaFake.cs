using System.Text;

namespace DbStudio.Sources.Kafka.Tests;

/// <summary>
/// In-memory broker model behind <see cref="IKafkaGateway"/> (docs/PLAN-M2.md 7.6, D11): brokers and a controller, topics
/// with partitions (append-only logs with low/high watermarks and timestamps), topic/broker configs, consumer groups with
/// members and committed offsets, manually assigned readers with EOF notifications, and error injection.
/// </summary>
public sealed class KafkaFake : IKafkaGateway
{
    public readonly object Gate = new();
    public List<KBroker> Brokers { get; } = [new(1, "broker1", 9092, "rack-a"), new(2, "broker2", 9092, "rack-b"), new(3, "broker3", 9092, null)];
    public int? ControllerId { get; set; } = 1;
    public string ClusterId { get; set; } = "fake-cluster-1";
    public Dictionary<string, FakeTopic> Topics { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, FakeGroup> Groups { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> BrokerConfigs { get; } = new(StringComparer.Ordinal)
    {
        ["inter.broker.protocol.version"] = "3.8-IV0", ["log.retention.hours"] = "168", ["num.partitions"] = "1",
    };

    /// <summary>Operation name → exception thrown by its next call (once).</summary>
    public Dictionary<string, KafkaGatewayException> FailNext { get; } = new(StringComparer.Ordinal);
    public List<string> Calls { get; } = [];
    public List<FakeReader> Readers { get; } = [];
    public bool Disposed { get; private set; }
    public TimeSpan WatermarkDelay { get; set; } = TimeSpan.Zero;

    public string LibraryVersion => "fake";

    public sealed class FakePartition
    {
        public long Low;
        public readonly List<KRecord> Log = [];
        public long High => Low + Log.Count;
        public List<int> Replicas = [1];
        public List<int> Isr = [1];
        public int Leader = 1;
    }

    public sealed class FakeTopic(string name, bool @internal)
    {
        public string Name { get; } = name;
        public bool Internal { get; } = @internal;
        public List<FakePartition> Partitions { get; } = [];
        public Dictionary<string, string> Configs { get; } = new(StringComparer.Ordinal);
    }

    public sealed class FakeGroup(string id)
    {
        public string Id { get; } = id;
        public string State { get; set; } = "Empty";
        public string? Protocol { get; set; }
        public List<KGroupMember> Members { get; } = [];
        public Dictionary<KTopicPartition, long> Offsets { get; } = [];
    }

    // ------------------------------------------------------------------ seeding helpers

    public FakeTopic AddTopic(string name, int partitions = 1, int replicas = 1, bool @internal = false)
    {
        lock (Gate)
        {
            var t = new FakeTopic(name, @internal || name.StartsWith("__", StringComparison.Ordinal));
            for (var i = 0; i < partitions; i++)
            {
                var ids = Enumerable.Range(1, replicas).Select(r => (i + r - 1) % Brokers.Count + 1).ToList();
                t.Partitions.Add(new FakePartition { Replicas = ids, Isr = [.. ids], Leader = ids[0] });
            }
            Topics[name] = t;
            return t;
        }
    }

    public KRecord Append(string topic, int partition, string? key, string? value, DateTimeOffset? ts = null, params (string, string?)[] headers) =>
        AppendBytes(topic, partition, key is null ? null : Encoding.UTF8.GetBytes(key), value is null ? null : Encoding.UTF8.GetBytes(value), ts, headers);

    public KRecord AppendBytes(string topic, int partition, byte[]? key, byte[]? value, DateTimeOffset? ts = null, params (string, string?)[] headers)
    {
        lock (Gate)
        {
            var p = Topics[topic].Partitions[partition];
            var r = new KRecord(topic, partition, p.High, ts ?? DateTimeOffset.UtcNow, "create", key, value,
                headers.Select(h => new KHeader(h.Item1, h.Item2 is null ? null : Encoding.UTF8.GetBytes(h.Item2))).ToList());
            p.Log.Add(r);
            return r;
        }
    }

    public FakeGroup AddGroup(string id, string state = "Empty", params (string Topic, int Partition, long Offset)[] offsets)
    {
        lock (Gate)
        {
            var g = new FakeGroup(id) { State = state, Protocol = state == "Empty" ? null : "range" };
            foreach (var (t, p, o) in offsets) g.Offsets[new KTopicPartition(t, p)] = o;
            Groups[id] = g;
            return g;
        }
    }

    private void Hit(string op)
    {
        lock (Gate)
        {
            Calls.Add(op);
            if (FailNext.Remove(op, out var ex)) throw ex;
        }
    }

    private FakeTopic TopicOrThrow(string name) =>
        Topics.TryGetValue(name, out var t) ? t : throw new KafkaGatewayException(KafkaErrorKind.UnknownTopic, "Broker: Unknown topic or partition");

    // ------------------------------------------------------------------ IKafkaGateway

    public Task<KMetadata> MetadataAsync(string? topic, CancellationToken ct)
    {
        Hit("Metadata");
        lock (Gate)
        {
            var topics = topic is null ? Topics.Values.ToList() : [TopicOrThrow(topic)];
            return Task.FromResult(new KMetadata(Brokers.ToList(), topics.Select(t => new KTopicMeta(t.Name,
                t.Partitions.Select((p, i) => new KPartitionMeta(i, p.Leader, p.Replicas.ToList(), p.Isr.ToList())).ToList(), t.Internal)).ToList(), 1));
        }
    }

    public Task<KClusterInfo> DescribeClusterAsync(CancellationToken ct)
    {
        Hit("DescribeCluster");
        lock (Gate) return Task.FromResult(new KClusterInfo(ClusterId, ControllerId, Brokers.ToList()));
    }

    public Task<IReadOnlyList<KConfigEntry>> DescribeConfigsAsync(KConfigResource kind, string name, CancellationToken ct)
    {
        Hit("DescribeConfigs");
        lock (Gate)
        {
            if (kind == KConfigResource.Broker)
            {
                if (!int.TryParse(name, out var id) || Brokers.All(b => b.Id != id)) throw new KafkaGatewayException(KafkaErrorKind.InvalidRequest, $"Broker {name} unknown");
                IReadOnlyList<KConfigEntry> broker = BrokerConfigs.Select(kv => new KConfigEntry(kv.Key, kv.Value, "static_broker_config", false, true, false, []))
                    .Append(new KConfigEntry("ssl.keystore.password", null, "static_broker_config", false, true, true, []))
                    .OrderBy(e => e.Name, StringComparer.Ordinal).ToList();
                return Task.FromResult(broker);
            }
            var t = TopicOrThrow(name);
            var defaults = new Dictionary<string, string> { ["cleanup.policy"] = "delete", ["retention.ms"] = "604800000", ["segment.bytes"] = "1073741824" };
            var entries = defaults.Where(d => !t.Configs.ContainsKey(d.Key))
                .Select(d => new KConfigEntry(d.Key, d.Value, "default_config", true, false, false, [new KConfigSynonym(d.Key, d.Value, "default_config")]))
                .Concat(t.Configs.Select(c => new KConfigEntry(c.Key, c.Value, "dynamic_topic_config", false, false, false,
                    [new KConfigSynonym(c.Key, c.Value, "dynamic_topic_config")])))
                .OrderBy(e => e.Name, StringComparer.Ordinal).ToList();
            return Task.FromResult<IReadOnlyList<KConfigEntry>>(entries);
        }
    }

    public Task CreateTopicAsync(string name, int partitions, short replicationFactor, IReadOnlyDictionary<string, string> configs, CancellationToken ct)
    {
        Hit("CreateTopic");
        lock (Gate)
        {
            if (Topics.ContainsKey(name)) throw new KafkaGatewayException(KafkaErrorKind.TopicExists, $"Topic '{name}' already exists.");
            if (replicationFactor > Brokers.Count)
                throw new KafkaGatewayException(KafkaErrorKind.InvalidRequest, $"Replication factor: {replicationFactor} larger than available brokers: {Brokers.Count}.");
            var t = AddTopic(name, partitions, replicationFactor);
            foreach (var (k, v) in configs) t.Configs[k] = v;
        }
        return Task.CompletedTask;
    }

    public Task DeleteTopicAsync(string name, CancellationToken ct)
    {
        Hit("DeleteTopic");
        lock (Gate)
        {
            TopicOrThrow(name);
            Topics.Remove(name);
        }
        return Task.CompletedTask;
    }

    public Task CreatePartitionsAsync(string topic, int totalCount, CancellationToken ct)
    {
        Hit("CreatePartitions");
        lock (Gate)
        {
            var t = TopicOrThrow(topic);
            if (totalCount <= t.Partitions.Count) throw new KafkaGatewayException(KafkaErrorKind.InvalidRequest, "Topic already has more partitions");
            while (t.Partitions.Count < totalCount) t.Partitions.Add(new FakePartition());
        }
        return Task.CompletedTask;
    }

    public Task AlterTopicConfigsAsync(string topic, IReadOnlyDictionary<string, string> set, IReadOnlyList<string> delete, CancellationToken ct)
    {
        Hit("AlterConfigs");
        lock (Gate)
        {
            var t = TopicOrThrow(topic);
            foreach (var (k, v) in set)
            {
                if (k == "bogus.config") throw new KafkaGatewayException(KafkaErrorKind.InvalidRequest, "Unknown topic config name: bogus.config");
                t.Configs[k] = v;
            }
            foreach (var d in delete) t.Configs.Remove(d);
        }
        return Task.CompletedTask;
    }

    public Task<IReadOnlyDictionary<int, long>> DeleteRecordsAsync(string topic, IReadOnlyDictionary<int, long> before, CancellationToken ct)
    {
        Hit("DeleteRecords");
        lock (Gate)
        {
            var t = TopicOrThrow(topic);
            var result = new Dictionary<int, long>();
            foreach (var (pid, off) in before)
            {
                var p = t.Partitions[pid];
                var cut = (int)Math.Clamp(off - p.Low, 0, p.Log.Count);
                p.Log.RemoveRange(0, cut);
                p.Low += cut;
                result[pid] = p.Low;
            }
            return Task.FromResult<IReadOnlyDictionary<int, long>>(result);
        }
    }

    public async Task<IReadOnlyDictionary<KTopicPartition, KWatermarks>> WatermarksAsync(IReadOnlyList<KTopicPartition> partitions, CancellationToken ct)
    {
        Hit("Watermarks");
        if (WatermarkDelay > TimeSpan.Zero) await Task.Delay(WatermarkDelay, ct);
        lock (Gate)
        {
            var result = new Dictionary<KTopicPartition, KWatermarks>();
            foreach (var tp in partitions)
            {
                var t = TopicOrThrow(tp.Topic);
                if (tp.Partition >= t.Partitions.Count) throw new KafkaGatewayException(KafkaErrorKind.UnknownTopic, "Unknown partition");
                var p = t.Partitions[tp.Partition];
                result[tp] = new KWatermarks(p.Low, p.High);
            }
            return result;
        }
    }

    public Task<IReadOnlyDictionary<KTopicPartition, long?>> OffsetsForTimesAsync(IReadOnlyList<KTopicPartition> partitions, DateTimeOffset timestamp, CancellationToken ct)
    {
        Hit("OffsetsForTimes");
        lock (Gate)
        {
            var result = new Dictionary<KTopicPartition, long?>();
            foreach (var tp in partitions)
                result[tp] = TopicOrThrow(tp.Topic).Partitions[tp.Partition].Log.FirstOrDefault(r => r.Timestamp >= timestamp)?.Offset;
            return Task.FromResult<IReadOnlyDictionary<KTopicPartition, long?>>(result);
        }
    }

    public IKafkaReader CreateReader(string purpose)
    {
        Hit("CreateReader");
        var r = new FakeReader(this, purpose);
        lock (Gate) Readers.Add(r);
        return r;
    }

    public Task<IReadOnlyList<KDelivery>> ProduceAsync(string topic, IReadOnlyList<KProduceRecord> records, string? compression, CancellationToken ct)
    {
        Hit("Produce");
        lock (Gate)
        {
            var t = TopicOrThrow(topic);
            LastCompression = compression;
            var result = new List<KDelivery>();
            var rr = 0;
            foreach (var r in records)
            {
                var pid = r.Partition ?? (r.Key is null ? rr++ % t.Partitions.Count : (int)((uint)Fnv(r.Key) % (uint)t.Partitions.Count));
                var p = t.Partitions[pid];
                var rec = new KRecord(topic, pid, p.High, DateTimeOffset.UtcNow, "create", r.Key, r.Value, r.Headers);
                p.Log.Add(rec);
                result.Add(new KDelivery(pid, rec.Offset, rec.Timestamp));
            }
            return Task.FromResult<IReadOnlyList<KDelivery>>(result);
        }
    }

    public string? LastCompression { get; private set; }

    private static int Fnv(byte[] key)
    {
        unchecked
        {
            var h = (int)2166136261;
            foreach (var b in key) h = (h ^ b) * 16777619;
            return h;
        }
    }

    public Task<IReadOnlyList<KGroupListing>> ListGroupsAsync(CancellationToken ct)
    {
        Hit("ListGroups");
        lock (Gate) return Task.FromResult<IReadOnlyList<KGroupListing>>(Groups.Values.Select(g => new KGroupListing(g.Id, g.State, false)).ToList());
    }

    public Task<IReadOnlyList<KGroupDescription>> DescribeGroupsAsync(IReadOnlyList<string> groupIds, CancellationToken ct)
    {
        Hit("DescribeGroups");
        lock (Gate)
        {
            return Task.FromResult<IReadOnlyList<KGroupDescription>>(groupIds.Select(id => Groups.TryGetValue(id, out var g)
                ? new KGroupDescription(id, g.State, g.Protocol, Brokers[0], g.Members.ToList())
                : new KGroupDescription(id, "Dead", null, Brokers[0], [])).ToList());
        }
    }

    public Task<IReadOnlyList<KCommitted>> GroupOffsetsAsync(string groupId, CancellationToken ct)
    {
        Hit("GroupOffsets");
        lock (Gate)
        {
            return Task.FromResult<IReadOnlyList<KCommitted>>(Groups.TryGetValue(groupId, out var g)
                ? g.Offsets.Select(kv => new KCommitted(kv.Key, kv.Value)).ToList() : []);
        }
    }

    public Task AlterGroupOffsetsAsync(string groupId, IReadOnlyDictionary<KTopicPartition, long> offsets, CancellationToken ct)
    {
        Hit("AlterGroupOffsets");
        lock (Gate)
        {
            if (!Groups.TryGetValue(groupId, out var g)) Groups[groupId] = g = new FakeGroup(groupId);
            if (g.Members.Count > 0) throw new KafkaGatewayException(KafkaErrorKind.GroupNotEmpty, "Broker: Specified group generation id is not valid");
            foreach (var (tp, o) in offsets) g.Offsets[tp] = o;
        }
        return Task.CompletedTask;
    }

    public Task DeleteGroupAsync(string groupId, CancellationToken ct)
    {
        Hit("DeleteGroup");
        lock (Gate)
        {
            if (!Groups.Remove(groupId)) throw new KafkaGatewayException(KafkaErrorKind.UnknownGroup, "Broker: Group id not found");
        }
        return Task.CompletedTask;
    }

    public void Dispose() => Disposed = true;

    /// <summary>Round-robin over the assigned partitions; EOF once per catch-up (re-armed by new records).</summary>
    public sealed class FakeReader(KafkaFake fake, string purpose) : IKafkaReader
    {
        private readonly Dictionary<KTopicPartition, long> _positions = [];
        private readonly HashSet<KTopicPartition> _eofSent = [];
        private int _next;

        public string Purpose { get; } = purpose;
        public bool Paused { get; private set; }
        public bool Disposed { get; private set; }
        public IReadOnlyDictionary<KTopicPartition, long> Positions => _positions;

        public void Assign(IReadOnlyList<(KTopicPartition Tp, long Offset)> start)
        {
            lock (fake.Gate)
            {
                foreach (var (tp, off) in start)
                {
                    var p = fake.Topics[tp.Topic].Partitions[tp.Partition];
                    _positions[tp] = off < 0 ? p.High : Math.Max(off, p.Low);
                }
            }
        }

        public KConsumeResult? Consume(TimeSpan timeout, CancellationToken ct)
        {
            var until = DateTime.UtcNow + timeout;
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                if (!Paused)
                {
                    lock (fake.Gate)
                    {
                        var keys = _positions.Keys.ToList();
                        for (var i = 0; i < keys.Count; i++)
                        {
                            var tp = keys[(_next + i) % keys.Count];
                            if (!fake.Topics.TryGetValue(tp.Topic, out var t)) continue;
                            var p = t.Partitions[tp.Partition];
                            var pos = Math.Max(_positions[tp], p.Low);
                            if (pos < p.High)
                            {
                                _next = (_next + i + 1) % keys.Count;
                                _positions[tp] = pos + 1;
                                _eofSent.Remove(tp);
                                return new KConsumeResult(p.Log[(int)(pos - p.Low)]);
                            }
                            if (_eofSent.Add(tp))
                            {
                                _next = (_next + i + 1) % keys.Count;
                                return new KConsumeResult(null, tp, pos);
                            }
                        }
                    }
                }
                if (DateTime.UtcNow >= until) return null;
                Thread.Sleep(5);
            }
        }

        public void Pause() => Paused = true;

        public void Resume() => Paused = false;

        public void Dispose() => Disposed = true;
    }
}
