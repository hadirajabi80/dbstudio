using System.Text.RegularExpressions;
using ClickHouse.Driver;
using DbStudio.Core.Models;
using DbStudio.Core.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;

namespace DbStudio.Providers.ClickHouse.Endpoints;

// Wire models of /clickhouse/{cid}/… (ui/src/api/types.clickhouse.ts).

public sealed record ChPartition(string Partition, string PartitionId, long Parts, long Rows, long BytesOnDisk, long DataCompressedBytes,
    long DataUncompressedBytes, string? MinTime, string? MaxTime, string? LastModified);

public sealed record ChPart(string Name, string Partition, string PartitionId, bool Active, string PartType, long Rows, long Marks, long BytesOnDisk,
    long DataCompressedBytes, long DataUncompressedBytes, long Level, long MinBlock, long MaxBlock, string? ModificationTime, string? Disk);

public sealed record ChPartsResponse(string Database, string Table, string? Engine, string? PartitionKey, string? SortingKey, string? PrimaryKey,
    string? SamplingKey, string? Ttl, long? TotalRows, long? TotalBytes, IReadOnlyList<ChPartition> Partitions, IReadOnlyList<ChPart> Parts);

public sealed record ChMutation(string Database, string Table, string MutationId, string Command, string? CreateTime, bool IsDone, long PartsToDo,
    bool IsKilled, string? LatestFailReason, string? LatestFailTime);

public sealed record ChMerge(string Database, string Table, double ElapsedSec, double Progress, long NumParts, string ResultPartName, string? PartitionId,
    long TotalSizeBytesCompressed, long RowsRead, long RowsWritten, long MemoryUsage, bool IsMutation, string? MergeType);

public sealed record ChActionResult(bool Ok, string Message);

public sealed record ChKillMutationRequest(string? Database, string? Table, string? MutationId);

public sealed record ChOptimizeRequest(string? Database, string? Table, string? Partition = null, bool Final = false, bool Deduplicate = false);

public sealed record ChPartitionRequest(string? Database, string? Table, string? PartitionId);

/// <summary>
/// The ClickHouse admin endpoints (plan-batch3 WP-CH): parts/partitions of a table (<c>system.parts</c>), mutations
/// (<c>system.mutations</c>, KILL MUTATION), running merges (<c>system.merges</c>), OPTIMIZE and DROP/DETACH PARTITION.
/// Writes answer 403 READ_ONLY on read-only connections. Sessionless requests over the provider's connection pool.
/// </summary>
public sealed partial class ChAdminService(ConnectionStore connections, ClickHouseProvider provider)
{
    private const string Ts = "'%Y-%m-%dT%H:%i:%SZ'";

    public const string PartsSql = $$"""
        SELECT name, partition, partition_id, active, part_type, rows, marks, bytes_on_disk, data_compressed_bytes, data_uncompressed_bytes,
            level, min_block_number, max_block_number, formatDateTime(toTimeZone(modification_time, 'UTC'), {{Ts}}), disk_name,
            if(min_time = 0, '', formatDateTime(toTimeZone(min_time, 'UTC'), {{Ts}})), if(max_time = 0, '', formatDateTime(toTimeZone(max_time, 'UTC'), {{Ts}}))
        FROM system.parts
        WHERE database = {db:String} AND table = {t:String}
        ORDER BY partition_id, min_block_number, level
        LIMIT 20000
        """;

    public const string TableSql = """
        SELECT engine, partition_key, sorting_key, primary_key, sampling_key, total_rows, total_bytes, create_table_query
        FROM system.tables WHERE database = {db:String} AND name = {t:String}
        """;

    public const string MutationsSql = $$"""
        SELECT database, table, mutation_id, command, formatDateTime(toTimeZone(create_time, 'UTC'), {{Ts}}), is_done, parts_to_do, is_killed,
            latest_fail_reason, if(latest_fail_time = 0, '', formatDateTime(toTimeZone(latest_fail_time, 'UTC'), {{Ts}}))
        FROM system.mutations
        WHERE database NOT IN ('system') AND ({db:Nullable(String)} IS NULL OR database = {db:Nullable(String)})
            AND ({t:Nullable(String)} IS NULL OR table = {t:Nullable(String)})
        ORDER BY create_time DESC
        LIMIT 1000
        """;

    public const string MergesSql = """
        SELECT database, table, elapsed, progress, num_parts, result_part_name, partition_id, total_size_bytes_compressed, rows_read, rows_written,
            memory_usage, is_mutation, toString(merge_type)
        FROM system.merges
        WHERE ({db:Nullable(String)} IS NULL OR database = {db:Nullable(String)}) AND ({t:Nullable(String)} IS NULL OR table = {t:Nullable(String)})
        ORDER BY elapsed DESC
        """;

    [GeneratedRegex(@"\bTTL\s+(?<ttl>.+?)(?=\s+SETTINGS\b|\s+COMMENT\b|$)", RegexOptions.CultureInvariant | RegexOptions.Singleline)]
    private static partial Regex TtlClause();

    private async Task<ChConnection> OpenAsync(string cid, CancellationToken ct)
    {
        var profile = Profile(cid);
        return await ChConnections.OpenAsync(profile, connections.GetPassword(cid), null, null, ct, provider.Handler).ConfigureAwait(false);
    }

    private ConnectionProfile Profile(string cid)
    {
        var profile = connections.Get(cid);
        if (profile.ProviderId != ClickHouseModule.ProviderId)
            throw EngineException.Validation($"Connection '{cid}' is not a ClickHouse connection.", new { field = "connectionId" });
        return profile;
    }

    private void RequireWritable(string cid, string action)
    {
        var p = Profile(cid);
        if (p.ReadOnly) throw EngineException.ReadOnly(p.Name, action);
    }

    private static string Required(string? value, string field) =>
        string.IsNullOrWhiteSpace(value) ? throw EngineException.Validation($"{field} is required.", new { field }) : value.Trim();

    private static async Task<T> Guard<T>(Func<Task<T>> work)
    {
        try
        {
            return await work().ConfigureAwait(false);
        }
        catch (ClickHouseServerException ex) when (ChErrors.IsPrivilegeError(ex.ErrorCode))
        {
            throw EngineException.Privilege(ChErrors.CleanMessage(ex.Message), null);
        }
        catch (ClickHouseServerException ex)
        {
            throw new EngineException(422, ErrorCodes.ProviderError, ChErrors.CleanMessage(ex.Message), new { code = ex.ErrorCode });
        }
        catch (HttpRequestException ex)
        {
            throw EngineException.SourceUnavailable($"Cannot reach the ClickHouse server: {ex.Message}");
        }
    }

    public Task<ChPartsResponse> PartsAsync(string cid, string? database, string? table, CancellationToken ct) => Guard(async () =>
    {
        var db = Required(database, "database");
        var t = Required(table, "table");
        await using var ch = await OpenAsync(cid, ct).ConfigureAwait(false);
        var info = (await ChDb.QueryAsync(ch.Connection, TableSql, r => (Engine: ChDb.Str(r, 0), Partition: ChDb.Str(r, 1), Sorting: ChDb.Str(r, 2),
            Primary: ChDb.Str(r, 3), Sampling: ChDb.Str(r, 4), Rows: ChDb.Long(r, 5), Bytes: ChDb.Long(r, 6), Create: ChDb.S(r, 7)), ct, ("db", db), ("t", t)).ConfigureAwait(false))
            .FirstOrDefault();
        if (info == default) throw EngineException.NotFound($"Table {db}.{t}");
        var parts = await ChDb.QueryAsync(ch.Connection, PartsSql, r => (Part: new ChPart(ChDb.S(r, 0), ChDb.S(r, 1), ChDb.S(r, 2), ChDb.Bool(r, 3), ChDb.S(r, 4),
            ChDb.Long(r, 5) ?? 0, ChDb.Long(r, 6) ?? 0, ChDb.Long(r, 7) ?? 0, ChDb.Long(r, 8) ?? 0, ChDb.Long(r, 9) ?? 0, ChDb.Long(r, 10) ?? 0,
            ChDb.Long(r, 11) ?? 0, ChDb.Long(r, 12) ?? 0, Empty(ChDb.Str(r, 13)), Empty(ChDb.Str(r, 14))), MinTime: Empty(ChDb.Str(r, 15)), MaxTime: Empty(ChDb.Str(r, 16))),
            ct, ("db", db), ("t", t)).ConfigureAwait(false);
        var partitions = parts.Where(p => p.Part.Active).GroupBy(p => p.Part.PartitionId, StringComparer.Ordinal).Select(g => new ChPartition(
            g.First().Part.Partition, g.Key, g.Count(), g.Sum(x => x.Part.Rows), g.Sum(x => x.Part.BytesOnDisk), g.Sum(x => x.Part.DataCompressedBytes),
            g.Sum(x => x.Part.DataUncompressedBytes), g.Select(x => x.MinTime).Where(x => x is not null).Min(), g.Select(x => x.MaxTime).Where(x => x is not null).Max(),
            g.Select(x => x.Part.ModificationTime).Where(x => x is not null).Max())).ToList();
        var ttl = TtlClause().Match(info.Create);
        return new ChPartsResponse(db, t, info.Engine, Empty(info.Partition), Empty(info.Sorting), Empty(info.Primary), Empty(info.Sampling),
            ttl.Success ? ttl.Groups["ttl"].Value.Trim() : null, info.Rows, info.Bytes, partitions, parts.Select(p => p.Part).ToList());
    });

    private static string? Empty(string? s) => string.IsNullOrEmpty(s) ? null : s;

    public Task<IReadOnlyList<ChMutation>> MutationsAsync(string cid, string? database, string? table, CancellationToken ct) => Guard(async () =>
    {
        await using var ch = await OpenAsync(cid, ct).ConfigureAwait(false);
        IReadOnlyList<ChMutation> list = await ChDb.QueryAsync(ch.Connection, MutationsSql, r => new ChMutation(ChDb.S(r, 0), ChDb.S(r, 1), ChDb.S(r, 2), ChDb.S(r, 3),
            Empty(ChDb.Str(r, 4)), ChDb.Bool(r, 5), ChDb.Long(r, 6) ?? 0, ChDb.Bool(r, 7), Empty(ChDb.Str(r, 8)), Empty(ChDb.Str(r, 9))),
            ct, ("db", Empty(database?.Trim())), ("t", Empty(table?.Trim()))).ConfigureAwait(false);
        return list;
    });

    public Task<IReadOnlyList<ChMerge>> MergesAsync(string cid, string? database, string? table, CancellationToken ct) => Guard(async () =>
    {
        await using var ch = await OpenAsync(cid, ct).ConfigureAwait(false);
        IReadOnlyList<ChMerge> list = await ChDb.QueryAsync(ch.Connection, MergesSql, r => new ChMerge(ChDb.S(r, 0), ChDb.S(r, 1),
            Convert.ToDouble(r.GetValue(2), System.Globalization.CultureInfo.InvariantCulture), Convert.ToDouble(r.GetValue(3), System.Globalization.CultureInfo.InvariantCulture),
            ChDb.Long(r, 4) ?? 0, ChDb.S(r, 5), Empty(ChDb.Str(r, 6)), ChDb.Long(r, 7) ?? 0, ChDb.Long(r, 8) ?? 0, ChDb.Long(r, 9) ?? 0, ChDb.Long(r, 10) ?? 0,
            ChDb.Bool(r, 11), Empty(ChDb.Str(r, 12))), ct, ("db", Empty(database?.Trim())), ("t", Empty(table?.Trim()))).ConfigureAwait(false);
        return list;
    });

    public Task<ChActionResult> KillMutationAsync(string cid, ChKillMutationRequest? req, CancellationToken ct) => Guard(async () =>
    {
        RequireWritable(cid, "KILL MUTATION");
        var db = Required(req?.Database, "database");
        var t = Required(req?.Table, "table");
        var id = Required(req?.MutationId, "mutationId");
        await using var ch = await OpenAsync(cid, ct).ConfigureAwait(false);
        var rows = await ChDb.QueryAsync(ch.Connection,
            "KILL MUTATION WHERE database = {db:String} AND table = {t:String} AND mutation_id = {id:String} SYNC", r => ChDb.S(r, 0), ct,
            ("db", db), ("t", t), ("id", id)).ConfigureAwait(false);
        return rows.Count > 0
            ? new ChActionResult(true, $"Mutation {id} of {db}.{t} was killed.")
            : new ChActionResult(false, $"Mutation {id} of {db}.{t} was not found (it finished or was already killed).");
    });

    public Task<ChActionResult> OptimizeAsync(string cid, ChOptimizeRequest? req, CancellationToken ct) => Guard(async () =>
    {
        RequireWritable(cid, "OPTIMIZE TABLE");
        var db = Required(req?.Database, "database");
        var t = Required(req?.Table, "table");
        var sql = $"OPTIMIZE TABLE {ChSqlText.Qualified(db, t)}";
        if (!string.IsNullOrWhiteSpace(req!.Partition)) sql += $" PARTITION ID {ChSqlText.Literal(req.Partition.Trim())}";
        if (req.Final) sql += " FINAL";
        if (req.Deduplicate) sql += " DEDUPLICATE";
        await using var ch = await OpenAsync(cid, ct).ConfigureAwait(false);
        await using var cmd = ch.Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.CustomSettings["optimize_throw_if_noop"] = 0;
        await cmd.ExecuteNonQueryAsync(ct).ConfigureAwait(false);
        return new ChActionResult(true, $"{sql} finished.");
    });

    public Task<ChActionResult> PartitionAsync(string cid, string op, ChPartitionRequest? req, CancellationToken ct) => Guard(async () =>
    {
        var verb = op == "drop" ? "DROP" : "DETACH";
        RequireWritable(cid, $"{verb} PARTITION");
        var db = Required(req?.Database, "database");
        var t = Required(req?.Table, "table");
        var id = Required(req?.PartitionId, "partitionId");
        var sql = $"ALTER TABLE {ChSqlText.Qualified(db, t)} {verb} PARTITION ID {ChSqlText.Literal(id)}";
        await using var ch = await OpenAsync(cid, ct).ConfigureAwait(false);
        await ChDb.ExecuteAsync(ch.Connection, sql, ct).ConfigureAwait(false);
        return new ChActionResult(true, op == "drop" ? $"Partition {id} of {db}.{t} was dropped." : $"Partition {id} of {db}.{t} was detached.");
    });
}

public static class ChEndpoints
{
    public static RouteGroupBuilder MapClickHouse(this RouteGroupBuilder api)
    {
        var g = api.MapGroup("/clickhouse/{cid}");
        g.MapGet("/parts", (string cid, string? database, string? table, ChAdminService s, CancellationToken ct) => s.PartsAsync(cid, database, table, ct));
        g.MapGet("/mutations", (string cid, string? database, string? table, ChAdminService s, CancellationToken ct) => s.MutationsAsync(cid, database, table, ct));
        g.MapPost("/mutations/kill", (string cid, ChKillMutationRequest? req, ChAdminService s, CancellationToken ct) => s.KillMutationAsync(cid, req, ct));
        g.MapGet("/merges", (string cid, string? database, string? table, ChAdminService s, CancellationToken ct) => s.MergesAsync(cid, database, table, ct));
        g.MapPost("/optimize", (string cid, ChOptimizeRequest? req, ChAdminService s, CancellationToken ct) => s.OptimizeAsync(cid, req, ct));
        g.MapPost("/partitions/drop", (string cid, ChPartitionRequest? req, ChAdminService s, CancellationToken ct) => s.PartitionAsync(cid, "drop", req, ct));
        g.MapPost("/partitions/detach", (string cid, ChPartitionRequest? req, ChAdminService s, CancellationToken ct) => s.PartitionAsync(cid, "detach", req, ct));
        return api;
    }
}
