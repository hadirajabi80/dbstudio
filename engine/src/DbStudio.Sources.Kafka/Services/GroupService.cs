using System.Globalization;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka.Services;

/// <summary>
/// Consumer groups and offsets (docs/PLAN-M2.md 7.5): list with lag (high − committed per partition, computed in parallel
/// within a 10 s budget), detail with members and partitions, offset reset (dry run always allowed; applying needs a
/// writable connection and an Empty group, else 409 GROUP_ACTIVE with the members), delete.
/// </summary>
public sealed class GroupService
{
    public static readonly TimeSpan LagBudget = TimeSpan.FromSeconds(10);
    public static readonly string[] ActiveStates = ["Stable", "PreparingRebalance", "CompletingRebalance"];

    public async Task<IReadOnlyList<KafkaGroupSummaryDto>> ListAsync(KafkaClientHandle h, CancellationToken ct)
    {
        var gw = h.Gateway;
        var listings = await KafkaErrors.Call(() => gw.ListGroupsAsync(ct)).ConfigureAwait(false);
        var ids = listings.Select(l => l.GroupId).Order(StringComparer.Ordinal).ToList();
        var descriptions = new Dictionary<string, KGroupDescription>(StringComparer.Ordinal);
        foreach (var chunk in ids.Chunk(50))
            foreach (var d in await KafkaErrors.Call(() => gw.DescribeGroupsAsync(chunk, ct)).ConfigureAwait(false))
                descriptions[d.GroupId] = d;

        // Lag: committed offsets per group in parallel, then one watermark query for every partition involved.
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(LagBudget);
        var committed = new Dictionary<string, IReadOnlyList<KCommitted>?>(StringComparer.Ordinal);
        using var gate = new SemaphoreSlim(8);
        var tasks = ids.Select(async id =>
        {
            await gate.WaitAsync(budget.Token).ConfigureAwait(false);
            try { return (id, (IReadOnlyList<KCommitted>?)await gw.GroupOffsetsAsync(id, budget.Token).ConfigureAwait(false)); }
            catch (Exception ex) when (ex is KafkaGatewayException or OperationCanceledException && !ct.IsCancellationRequested) { return (id, null); }
            finally { gate.Release(); }
        }).ToList();
        try
        {
            foreach (var (id, offsets) in await Task.WhenAll(tasks).ConfigureAwait(false)) committed[id] = offsets;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { /* budget: lag stays null */ }

        IReadOnlyDictionary<KTopicPartition, KWatermarks>? marks = null;
        var tps = committed.Values.Where(v => v is not null).SelectMany(v => v!).Select(c => c.Tp).Distinct().ToList();
        if (tps.Count > 0 && !budget.IsCancellationRequested)
        {
            try { marks = await gw.WatermarksAsync(tps, budget.Token).ConfigureAwait(false); }
            catch (Exception ex) when (ex is KafkaGatewayException or OperationCanceledException && !ct.IsCancellationRequested) { /* lag stays null */ }
        }

        return ids.Select(id =>
        {
            descriptions.TryGetValue(id, out var d);
            var listing = listings.First(l => l.GroupId == id);
            var offsets = committed.GetValueOrDefault(id);
            long? lag = null;
            if (offsets is not null && (marks is not null || offsets.Count == 0))
            {
                lag = 0;
                foreach (var c in offsets)
                {
                    if (c.Offset is not { } off) continue;
                    if (marks is null || !marks.TryGetValue(c.Tp, out var w)) { lag = null; break; }
                    lag += Math.Max(0, w.High - off);
                }
            }
            var topics = (offsets ?? []).Select(c => c.Tp.Topic).Concat(d?.Members.SelectMany(m => m.Assignment).Select(a => a.Topic) ?? [])
                .Distinct().Order(StringComparer.Ordinal).ToList();
            return new KafkaGroupSummaryDto(id, d?.State ?? listing.State, d?.Protocol, d?.Members.Count ?? 0, topics, lag,
                d?.Coordinator is { } co ? new KafkaNodeRef(co.Id, $"{co.Host}:{co.Port}") : null);
        }).ToList();
    }

    public async Task<KafkaGroupDetailDto> DetailAsync(KafkaClientHandle h, string groupId, CancellationToken ct)
    {
        var (desc, committed) = await LoadAsync(h, groupId, ct).ConfigureAwait(false);
        var memberOf = new Dictionary<KTopicPartition, string>();
        foreach (var m in desc.Members) foreach (var tp in m.Assignment) memberOf[tp] = m.MemberId;
        var commits = committed.Where(c => c.Offset is not null).ToDictionary(c => c.Tp, c => c.Offset);
        var tps = commits.Keys.Concat(memberOf.Keys).Distinct().OrderBy(t => t.Topic, StringComparer.Ordinal).ThenBy(t => t.Partition).ToList();
        var marks = tps.Count == 0 ? new Dictionary<KTopicPartition, KWatermarks>()
            : await KafkaErrors.Call(() => h.Gateway.WatermarksAsync(tps, ct)).ConfigureAwait(false);
        var partitions = tps.Select(tp =>
        {
            var w = marks.GetValueOrDefault(tp);
            var c = commits.GetValueOrDefault(tp);
            return new KafkaGroupPartitionDto(tp.Topic, tp.Partition, c, w.High, w.Low, c is { } off ? Math.Max(0, w.High - off) : null, memberOf.GetValueOrDefault(tp));
        }).ToList();
        var members = desc.Members.Select(m => new KafkaGroupMemberDto(m.MemberId, m.ClientId, m.Host,
            m.Assignment.GroupBy(a => a.Topic).OrderBy(g => g.Key, StringComparer.Ordinal)
                .Select(g => new KafkaAssignmentDto(g.Key, g.Select(a => a.Partition).Order().ToList())).ToList())).ToList();
        return new KafkaGroupDetailDto(groupId, desc.State, desc.Protocol,
            desc.Coordinator is { } co ? new KafkaNodeRef(co.Id, $"{co.Host}:{co.Port}") : null, members, partitions);
    }

    private static async Task<(KGroupDescription Desc, IReadOnlyList<KCommitted> Committed)> LoadAsync(KafkaClientHandle h, string groupId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(groupId)) throw EngineException.Validation("A group id is required.", new { field = "groupId" });
        var desc = (await KafkaErrors.Call(() => h.Gateway.DescribeGroupsAsync([groupId], ct), groupId).ConfigureAwait(false)).FirstOrDefault();
        IReadOnlyList<KCommitted> committed;
        try { committed = await h.Gateway.GroupOffsetsAsync(groupId, ct).ConfigureAwait(false); }
        catch (KafkaGatewayException ex) when (ex.Kind == KafkaErrorKind.UnknownGroup) { committed = []; }
        catch (KafkaGatewayException ex) { throw KafkaErrors.ToEngine(ex, groupId); }
        if (desc is null || desc.State is "Dead" or "Unknown" && desc.Members.Count == 0 && committed.Count == 0)
            throw new EngineException(404, ErrorCodes.NotFound, $"Consumer group '{groupId}' was not found.");
        return (desc, committed);
    }

    public static bool IsActive(KGroupDescription d) => d.Members.Count > 0 || ActiveStates.Contains(d.State);

    private static EngineException GroupActive(KGroupDescription d, string action) => new(409, ErrorCodes.GroupActive,
        $"Consumer group '{d.GroupId}' is {d.State} with {d.Members.Count} member{(d.Members.Count == 1 ? "" : "s")}: stop its consumers before {action}.",
        new { state = d.State, members = d.Members.Select(m => new { m.MemberId, m.ClientId, m.Host }).ToList() });

    public async Task<IReadOnlyList<KafkaOffsetResetRow>> ResetAsync(KafkaClientHandle h, string groupId, KafkaOffsetResetRequest? req, CancellationToken ct)
    {
        if (req?.To is null) throw EngineException.Validation("to is required.", new { field = "to" });
        var kind = (req.To.Kind ?? "").Trim();
        if (kind is not ("earliest" or "latest" or "offset" or "timestamp" or "shiftBy"))
            throw EngineException.Validation("to.kind must be earliest, latest, offset, timestamp or shiftBy.", new { field = "to.kind" });
        long number = 0;
        DateTimeOffset ts = default;
        if (kind is "offset" or "shiftBy")
        {
            number = req.To.Value switch
            {
                { ValueKind: JsonValueKind.Number } v when v.TryGetInt64(out var n) => n,
                { ValueKind: JsonValueKind.String } v when long.TryParse(v.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) => n,
                _ => throw EngineException.Validation($"to.value must be a number for {kind}.", new { field = "to.value" }),
            };
            if (kind == "offset" && number < 0) throw EngineException.Validation("to.value must be ≥ 0.", new { field = "to.value" });
        }
        else if (kind == "timestamp")
        {
            if (req.To.Value is not { ValueKind: JsonValueKind.String } sv || !DateTimeOffset.TryParse(sv.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out ts))
                throw EngineException.Validation("to.value must be an ISO timestamp.", new { field = "to.value" });
        }

        var (desc, committed) = await LoadOrNewAsync(h, groupId, ct).ConfigureAwait(false);
        if (!req.DryRun)
        {
            h.EnsureWritable($"resetting the offsets of group '{groupId}'");
            if (IsActive(desc)) throw GroupActive(desc, "resetting offsets");
        }

        // Targets: explicit partitions, a whole topic, or every partition the group has committed.
        List<KTopicPartition> targets;
        if (req.Partitions is { Count: > 0 } parts)
        {
            targets = [];
            foreach (var g in parts.GroupBy(p => p.Topic ?? ""))
            {
                var topic = TopicService.ValidateName(g.Key, "partitions.topic");
                var meta = await TopicService.TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
                targets.AddRange(TopicService.SelectPartitions(meta, g.Select(p => p.Partition).ToList(), "partitions").Select(p => new KTopicPartition(topic, p)));
            }
        }
        else if (!string.IsNullOrWhiteSpace(req.Topic))
        {
            var topic = TopicService.ValidateName(req.Topic, "topic");
            var meta = await TopicService.TopicMetaAsync(h, topic, ct).ConfigureAwait(false);
            targets = meta.Partitions.Select(p => new KTopicPartition(topic, p.Id)).ToList();
        }
        else
        {
            targets = committed.Select(c => c.Tp).Distinct().ToList();
            if (targets.Count == 0) throw EngineException.Validation("The group has no committed offsets: choose a topic.", new { field = "topic" });
        }
        targets = targets.Distinct().OrderBy(t => t.Topic, StringComparer.Ordinal).ThenBy(t => t.Partition).ToList();

        var marks = await KafkaErrors.Call(() => h.Gateway.WatermarksAsync(targets, ct)).ConfigureAwait(false);
        IReadOnlyDictionary<KTopicPartition, long?>? times = kind == "timestamp"
            ? await KafkaErrors.Call(() => h.Gateway.OffsetsForTimesAsync(targets, ts, ct)).ConfigureAwait(false) : null;
        var current = committed.Where(c => c.Offset is not null).ToDictionary(c => c.Tp, c => c.Offset!.Value);
        var rows = targets.Select(tp => new KafkaOffsetResetRow(tp.Topic, tp.Partition, current.TryGetValue(tp, out var f) ? f : null,
            Target(kind, number, marks.GetValueOrDefault(tp), current.TryGetValue(tp, out var c) ? c : null, times?.GetValueOrDefault(tp)))).ToList();

        if (!req.DryRun)
            await KafkaErrors.Call(() => h.Gateway.AlterGroupOffsetsAsync(groupId, rows.ToDictionary(r => new KTopicPartition(r.Topic, r.Partition), r => r.To), ct), groupId)
                .ConfigureAwait(false);
        return rows;
    }

    /// <summary>The new offset of one partition (always clamped to the partition's [low, high]).</summary>
    public static long Target(string kind, long number, KWatermarks w, long? committed, long? forTime) => kind switch
    {
        "earliest" => w.Low,
        "latest" => w.High,
        "offset" => Math.Clamp(number, w.Low, w.High),
        "timestamp" => Math.Clamp(forTime ?? w.High, w.Low, w.High),
        _ => Math.Clamp((committed ?? w.High) + number, w.Low, w.High), // shiftBy from the committed position
    };

    /// <summary>A group that does not exist yet can receive offsets (Kafka creates it): treat it as Empty.</summary>
    private static async Task<(KGroupDescription, IReadOnlyList<KCommitted>)> LoadOrNewAsync(KafkaClientHandle h, string groupId, CancellationToken ct)
    {
        try { return await LoadAsync(h, groupId, ct).ConfigureAwait(false); }
        catch (EngineException ex) when (ex.Code == ErrorCodes.NotFound)
        {
            return (new KGroupDescription(groupId, "Empty", null, null, []), []);
        }
    }

    public async Task DeleteAsync(KafkaClientHandle h, string groupId, CancellationToken ct)
    {
        h.EnsureWritable($"deleting consumer group '{groupId}'");
        var (desc, _) = await LoadAsync(h, groupId, ct).ConfigureAwait(false);
        if (IsActive(desc)) throw GroupActive(desc, "deleting the group");
        await KafkaErrors.Call(() => h.Gateway.DeleteGroupAsync(groupId, ct), groupId).ConfigureAwait(false);
    }
}
