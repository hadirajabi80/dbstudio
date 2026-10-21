using System.Text.Json;
using DbStudio.Core.Services;
using DbStudio.Sources.Kafka.Services;

namespace DbStudio.Sources.Kafka.Tests;

public sealed class GroupTests
{
    private static Harness Seeded()
    {
        var h = new Harness();
        h.Fake.AddTopic("orders", 2);
        h.Fake.AddTopic("payments", 1);
        for (var i = 0; i < 10; i++) h.Fake.Append("orders", i % 2, null, $"o{i}");
        for (var i = 0; i < 4; i++) h.Fake.Append("payments", 0, null, $"p{i}", DateTimeOffset.UtcNow.AddMinutes(i - 10));
        h.Fake.AddGroup("billing", "Empty", ("orders", 0, 2), ("orders", 1, 5), ("payments", 0, 1));
        var active = h.Fake.AddGroup("shipping", "Stable", ("orders", 0, 4));
        active.Members.Add(new KGroupMember("m-1", "shipper-1", "/10.0.0.5", [new KTopicPartition("orders", 0), new KTopicPartition("orders", 1)]));
        return h;
    }

    private static KafkaOffsetResetRequest Reset(string kind, object? value = null, bool dryRun = true, string? topic = null, List<KafkaTopicPartitionRef>? parts = null) =>
        new(parts, topic, new KafkaResetTarget(kind, value is null ? null : JsonSerializer.SerializeToElement(value)), dryRun);

    [Fact]
    public async Task List_reports_state_members_topics_and_total_lag()
    {
        await using var h = Seeded();
        var groups = await new GroupService().ListAsync(h.Handle, default);
        var billing = groups.Single(g => g.GroupId == "billing");
        Assert.Equal("Empty", billing.State);
        Assert.Equal((5 - 2) + (5 - 5) + (4 - 1), billing.LagTotal);
        Assert.Equal(["orders", "payments"], billing.Topics);
        var shipping = groups.Single(g => g.GroupId == "shipping");
        Assert.Equal(1, shipping.Members);
        Assert.Equal(1, shipping.LagTotal);
        Assert.Equal(1, shipping.Coordinator!.Id);
    }

    [Fact]
    public async Task Lag_is_null_when_offsets_cannot_be_read()
    {
        await using var h = Seeded();
        h.Fake.FailNext["Watermarks"] = new KafkaGatewayException(KafkaErrorKind.Timeout, "Local: Timed out");
        var groups = await new GroupService().ListAsync(h.Handle, default);
        Assert.All(groups, g => Assert.Null(g.LagTotal));
    }

    [Fact]
    public async Task Detail_lists_members_and_per_partition_lag()
    {
        await using var h = Seeded();
        var d = await new GroupService().DetailAsync(h.Handle, "shipping", default);
        Assert.Equal("Stable", d.State);
        var m = Assert.Single(d.Members);
        Assert.Equal([0, 1], m.Assignments.Single().Partitions);
        var p0 = d.Partitions.Single(p => p.Partition == 0);
        Assert.Equal((4L, 5L, 1L), (p0.Committed!.Value, p0.High, p0.Lag!.Value));
        Assert.Equal("m-1", p0.MemberId);
        var p1 = d.Partitions.Single(p => p.Partition == 1);
        Assert.Null(p1.Committed);
        Assert.Null(p1.Lag);
    }

    [Fact]
    public async Task Unknown_group_is_404()
    {
        await using var h = Seeded();
        var ex = await Assert.ThrowsAsync<EngineException>(() => new GroupService().DetailAsync(h.Handle, "ghost", default));
        Assert.Equal(404, ex.Status);
    }

    [Theory]
    [InlineData("earliest", null, new long[] { 0, 0, 0 })]
    [InlineData("latest", null, new long[] { 5, 5, 4 })]
    [InlineData("offset", 3, new long[] { 3, 3, 3 })]
    [InlineData("offset", 99, new long[] { 5, 5, 4 })]
    [InlineData("shiftBy", -2, new long[] { 0, 3, 0 })]
    [InlineData("shiftBy", 10, new long[] { 5, 5, 4 })]
    public async Task Dry_run_previews_every_target_kind(string kind, object? value, long[] expected)
    {
        await using var h = Seeded();
        var rows = await new GroupService().ResetAsync(h.Handle, "billing", Reset(kind, value), default);
        Assert.Equal(expected, rows.Select(r => r.To));
        Assert.Equal([2L, 5L, 1L], rows.Select(r => r.From!.Value));
        Assert.DoesNotContain("AlterGroupOffsets", h.Fake.Calls);
    }

    [Fact]
    public async Task Timestamp_reset_uses_offsets_for_times()
    {
        await using var h = Seeded();
        var rows = await new GroupService().ResetAsync(h.Handle, "billing", Reset("timestamp", DateTimeOffset.UtcNow.AddMinutes(-8.5).ToString("O"), topic: "payments"), default);
        var r = Assert.Single(rows);
        Assert.Equal(2, r.To);
    }

    [Fact]
    public async Task Apply_writes_offsets_on_an_empty_group()
    {
        await using var h = Seeded();
        var rows = await new GroupService().ResetAsync(h.Handle, "billing", Reset("earliest", dryRun: false, parts: [new("orders", 1)]), default);
        var r = Assert.Single(rows);
        Assert.Equal((5L, 0L), (r.From!.Value, r.To));
        Assert.Equal(0, h.Fake.Groups["billing"].Offsets[new KTopicPartition("orders", 1)]);
        Assert.Equal(2, h.Fake.Groups["billing"].Offsets[new KTopicPartition("orders", 0)]);
    }

    [Fact]
    public async Task Apply_is_refused_on_an_active_group_with_its_members()
    {
        await using var h = Seeded();
        var svc = new GroupService();
        var preview = await svc.ResetAsync(h.Handle, "shipping", Reset("latest"), default);
        Assert.Single(preview);
        var ex = await Assert.ThrowsAsync<EngineException>(() => svc.ResetAsync(h.Handle, "shipping", Reset("latest", dryRun: false), default));
        Assert.Equal(409, ex.Status);
        Assert.Equal(ErrorCodes.GroupActive, ex.Code);
        Assert.Contains("shipper-1", JsonSerializer.Serialize(ex.Detail, CoreJson.Options));
        Assert.DoesNotContain("AlterGroupOffsets", h.Fake.Calls);
    }

    [Fact]
    public async Task Reset_of_a_new_group_needs_a_topic()
    {
        await using var h = Seeded();
        var svc = new GroupService();
        var ex = await Assert.ThrowsAsync<EngineException>(() => svc.ResetAsync(h.Handle, "fresh", Reset("earliest"), default));
        Assert.Contains("topic", JsonSerializer.Serialize(ex.Detail));
        var rows = await svc.ResetAsync(h.Handle, "fresh", Reset("latest", dryRun: false, topic: "orders"), default);
        Assert.All(rows, r => Assert.Null(r.From));
        Assert.Equal(2, h.Fake.Groups["fresh"].Offsets.Count);
    }

    [Theory]
    [InlineData("rewind", null, "to.kind")]
    [InlineData("offset", null, "to.value")]
    [InlineData("offset", -1, "to.value")]
    [InlineData("timestamp", 5, "to.value")]
    public async Task Reset_validation_names_the_field(string kind, object? value, string field)
    {
        await using var h = Seeded();
        var ex = await Assert.ThrowsAsync<EngineException>(() => new GroupService().ResetAsync(h.Handle, "billing", Reset(kind, value), default));
        Assert.Contains(field, JsonSerializer.Serialize(ex.Detail));
    }

    [Fact]
    public async Task Read_only_allows_dry_run_but_refuses_apply_and_delete()
    {
        await using var h = new Harness(readOnly: true);
        h.Fake.AddTopic("orders");
        h.Fake.Append("orders", 0, null, "x");
        h.Fake.AddGroup("billing", "Empty", ("orders", 0, 0));
        var svc = new GroupService();
        Assert.Single(await svc.ResetAsync(h.Handle, "billing", Reset("latest"), default));
        var apply = await Assert.ThrowsAsync<EngineException>(() => svc.ResetAsync(h.Handle, "billing", Reset("latest", dryRun: false), default));
        Assert.Equal(ErrorCodes.ReadOnly, apply.Code);
        var delete = await Assert.ThrowsAsync<EngineException>(() => svc.DeleteAsync(h.Handle, "billing", default));
        Assert.Equal(ErrorCodes.ReadOnly, delete.Code);
    }

    [Fact]
    public async Task Delete_group_requires_an_inactive_group()
    {
        await using var h = Seeded();
        var svc = new GroupService();
        await Assert.ThrowsAsync<EngineException>(() => svc.DeleteAsync(h.Handle, "shipping", default));
        await svc.DeleteAsync(h.Handle, "billing", default);
        Assert.False(h.Fake.Groups.ContainsKey("billing"));
    }

    [Theory]
    [InlineData("earliest", 0, 10, 4, null, 10)]
    [InlineData("shiftBy", -3, 10, 20, 15L, 12)]
    [InlineData("shiftBy", 3, 0, 20, null, 20)]
    [InlineData("timestamp", 0, 0, 20, null, 20)]
    [InlineData("timestamp", 0, 0, 20, 7L, 7)]
    public void Target_offset_math(string kind, long number, long low, long high, long? committedOrTime, long expected)
    {
        var w = new KWatermarks(low, high);
        var actual = kind == "timestamp" ? GroupService.Target(kind, number, w, null, committedOrTime) : GroupService.Target(kind, number, w, committedOrTime, null);
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(Confluent.Kafka.ErrorCode.NotCoordinatorForGroup, true)]
    [InlineData(Confluent.Kafka.ErrorCode.GroupCoordinatorNotAvailable, true)]
    [InlineData(Confluent.Kafka.ErrorCode.GroupLoadInProgress, true)]
    [InlineData(Confluent.Kafka.ErrorCode.GroupIdNotFound, false)]
    [InlineData(Confluent.Kafka.ErrorCode.NonEmptyGroup, false)]
    [InlineData(Confluent.Kafka.ErrorCode.GroupAuthorizationFailed, false)]
    public void Coordinator_errors_are_retried_by_the_gateway(Confluent.Kafka.ErrorCode code, bool transient)
    {
        Assert.Equal(transient, ConfluentKafkaGateway.IsTransient(code));
        Assert.Equal(transient, ConfluentKafkaGateway.IsTransient(new Confluent.Kafka.KafkaException(new Confluent.Kafka.Error(code))));
    }
}
