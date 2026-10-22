using System.Text.Json.Nodes;
using DbStudio.Core.Designer;
using DbStudio.Core.Models;
using DbStudio.Core.Params;
using DbStudio.Core.Providers;
using DbStudio.Core.Services;
using DbStudio.Providers.Conformance;
using DbStudio.Providers.Oracle.Designer;

namespace DbStudio.Providers.Oracle.Tests;

/// <summary>
/// Editing table data and structure on a real Oracle server, with the statements exactly as the UI generates them
/// (ui/src/data/sqlgen.ts; the same strings are asserted in ui/src/data/sqlgen.plsql.test.ts) and run the way a grid
/// save runs them (ui/src/components/PendingChanges/submit.ts): auto-commit session switched to manual, one statement
/// per execute with :pN binds, "rows affected" checked, COMMIT, back to auto. Skipped without Docker.
/// </summary>
[Collection(ShopSchemaWriters.Name)]
public sealed class OracleDataEditTests(OracleFixture fixture) : IClassFixture<OracleFixture>
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(90);
    private readonly string _id = Guid.NewGuid().ToString("N")[..6].ToUpperInvariant();

    private void RequireAvailable() => Skip.IfNot(fixture.IsAvailable, fixture.SkipReason ?? "Oracle not available.");

    private string T(string name) => $"ED_{name}_{_id}";

    private static QueryParam P(string name, string kind, object? value) =>
        new(name, kind, value switch { null => null, string s => JsonValue.Create(s), long l => JsonValue.Create(l), int i => JsonValue.Create(i), double d => JsonValue.Create(d), _ => throw new ArgumentException("value") });

    private static QueryParam Out(string name, string kind) => new(name, kind, null, ParamDirections.Out);

    private sealed record Stmt(string Sql, IReadOnlyList<QueryParam> Params, bool ExpectOne = true);

    private static async Task<(ExecutionSummary Summary, RecordingSink Sink)> ExecAsync(IDbSession session, string sql, IReadOnlyList<QueryParam>? ps = null)
    {
        var sink = new RecordingSink();
        var summary = await session.ExecuteAsync(new ExecuteRequest([new SqlBatch(sql, 1, 1)], 1000, true, false, "data", ps is { Count: > 0 } ? ps : null), sink, CancellationToken.None)
            .WaitAsync(Timeout);
        return (summary, sink);
    }

    /// <summary>A grid save in auto-commit mode: manual for the statements, COMMIT on success, ROLLBACK on error/conflict.</summary>
    private static async Task<(bool Ok, string? Error, List<ExecutionSummary> Results)> SubmitAsync(IDbSession session, params Stmt[] statements)
    {
        await session.SetTransactionModeAsync(TransactionMode.Manual, CancellationToken.None);
        var results = new List<ExecutionSummary>();
        try
        {
            foreach (var st in statements)
            {
                var (summary, sink) = await ExecAsync(session, st.Sql, st.Params);
                results.Add(summary);
                if (summary.Status != ExecutionStatus.Ok)
                {
                    await session.RollbackAsync(CancellationToken.None);
                    return (false, string.Join("; ", sink.Errors.Select(e => e.Error.Message)), results);
                }
                if (st.ExpectOne && summary.RowsAffected == 0)
                {
                    await session.RollbackAsync(CancellationToken.None);
                    return (false, "conflict: 0 rows affected", results);
                }
            }
            await session.CommitAsync(CancellationToken.None);
            return (true, null, results);
        }
        finally
        {
            await session.SetTransactionModeAsync(TransactionMode.Auto, CancellationToken.None);
        }
    }

    /// <summary>Rows of a query, read on a separate session (so only committed data is seen).</summary>
    private async Task<List<object?[]>> CommittedRowsAsync(string sql)
    {
        await using var other = await fixture.OpenSessionAsync();
        var (summary, sink) = await ExecAsync(other, sql);
        Assert.True(summary.Status == ExecutionStatus.Ok, string.Join("; ", sink.Errors.Select(e => e.Error.Message)));
        return sink.ResultSets.Single().Rows;
    }

    private async Task DropAsync(params string[] tables)
    {
        foreach (var t in tables)
        {
            try { await fixture.RunBatchesAsync([$"DROP TABLE {t} PURGE"]); } catch (InvalidOperationException) { /* not created */ }
        }
    }

    [SkippableFact]
    public async Task PrimaryKeyTable_UpdateInsertDelete_Commit_WithVerifyUnchanged()
    {
        RequireAvailable();
        var t = T("PK");
        await fixture.RunBatchesAsync([
            $"CREATE TABLE {t} (ID NUMBER(10) PRIMARY KEY, NAME VARCHAR2(50), CH CHAR(5), DT DATE, CL CLOB, AMT NUMBER, TS TIMESTAMP, TSTZ TIMESTAMP WITH TIME ZONE)",
            $"INSERT INTO {t} VALUES (1, 'one', 'ab', TO_DATE('2026-01-02 13:14:15','YYYY-MM-DD HH24:MI:SS'), 'clob text', 1/3, TIMESTAMP '2026-03-04 05:06:07.123456', TIMESTAMP '2026-03-04 05:06:07.5 +03:30')",
            $"INSERT INTO {t} (ID, NAME) VALUES (2, 'two')",
        ]);
        try
        {
            await using var session = await fixture.OpenSessionAsync();
            // The grid's values as the engine reads them (DATE with its time, CHAR blank-padded, 40-digit NUMBER as text).
            var row = (await CommittedRowsAsync($"SELECT * FROM {t} WHERE ID = 1")).Single();
            Assert.Equal("ab   ", row[2]);
            Assert.Equal("2026-01-02T13:14:15", row[3]);
            Assert.Equal("0." + new string('3', 40), row[5]);

            // UPDATE with "verify unchanged values": every edited column's old value in the WHERE (the CLOB is written,
            // never compared: ORA-22848), each type bound as the grid binds it.
            var r = await SubmitAsync(session, new Stmt(
                $"UPDATE {t} SET NAME = :p1, CH = :p2, DT = :p3, CL = :p4, AMT = :p5, TS = :p6, TSTZ = :p7 WHERE ID = :p8 AND NAME = :p9 AND CH = :p10 AND DT = :p11 AND AMT = :p12 AND TS = :p13 AND TSTZ = :p14",
                [
                    P("p1", "string", "uno"), P("p2", "string", "xy"), P("p3", "datetime", "2027-05-06T07:08:09"), P("p4", "string", "new clob"),
                    P("p5", "decimal", "0." + new string('6', 40)), P("p6", "datetime", "2027-01-01T00:00:00.5"), P("p7", "datetimeoffset", "2027-01-01T00:00:00+02:00"),
                    P("p8", "int", 1L), P("p9", "string", "one"), P("p10", "string", "ab   "), P("p11", "datetime", "2026-01-02T13:14:15"),
                    P("p12", "decimal", "0." + new string('3', 40)), P("p13", "datetime", "2026-03-04T05:06:07.123456"), P("p14", "datetimeoffset", "2026-03-04T05:06:07.5+03:30"),
                ]));
            Assert.True(r.Ok, r.Error);
            Assert.Equal(1, r.Results[0].RowsAffected);
            row = (await CommittedRowsAsync($"SELECT * FROM {t} WHERE ID = 1")).Single();
            Assert.Equal(["uno", "xy   ", "2027-05-06T07:08:09", "new clob", "0." + new string('6', 40)], row[1..6]);

            // A stale old value is a conflict (0 rows), and nothing is saved.
            r = await SubmitAsync(session, new Stmt($"UPDATE {t} SET NAME = :p1 WHERE ID = :p2 AND NAME = :p3", [P("p1", "string", "x"), P("p2", "int", 1L), P("p3", "string", "one")]));
            Assert.False(r.Ok);
            Assert.Equal("conflict: 0 rows affected", r.Error);
            Assert.Equal("uno", (await CommittedRowsAsync($"SELECT NAME FROM {t} WHERE ID = 1")).Single()[0]);

            // '' is NULL in Oracle: the grid compares an old '' with IS NULL.
            r = await SubmitAsync(session, new Stmt($"UPDATE {t} SET NAME = :p1 WHERE ID = :p2", [P("p1", "string", ""), P("p2", "int", 2L)]));
            Assert.True(r.Ok, r.Error);
            Assert.Null((await CommittedRowsAsync($"SELECT NAME FROM {t} WHERE ID = 2")).Single()[0]);
            r = await SubmitAsync(session, new Stmt($"UPDATE {t} SET NAME = :p1 WHERE ID = :p2 AND NAME IS NULL", [P("p1", "string", "deux"), P("p2", "int", 2L)]));
            Assert.True(r.Ok, r.Error);

            // INSERT (explicit key) and DELETE with every comparable original value (the CLOB left out).
            r = await SubmitAsync(session,
                new Stmt($"DELETE FROM {t} WHERE ID = :p1 AND NAME = :p2 AND CH IS NULL AND DT IS NULL AND AMT IS NULL AND TS IS NULL AND TSTZ IS NULL", [P("p1", "int", 2L), P("p2", "string", "deux")]),
                new Stmt($"INSERT INTO {t} (ID, NAME, DT) VALUES (:p1, :p2, :p3)", [P("p1", "int", 3L), P("p2", "string", "three"), P("p3", "datetime", "2026-12-31T23:59:59")], ExpectOne: false));
            Assert.True(r.Ok, r.Error);
            Assert.Equal([[1m, "uno"], [3m, "three"]], (await CommittedRowsAsync($"SELECT ID, NAME FROM {t} ORDER BY ID")).Select(x => new object?[] { Convert.ToDecimal(x[0]), x[1] }));
        }
        finally
        {
            await DropAsync(t);
        }
    }

    [SkippableFact]
    public async Task KeylessTable_IsEditedByRowid_OneOfTwoIdenticalRows()
    {
        RequireAvailable();
        var t = T("NOPK");
        await fixture.RunBatchesAsync([
            $"CREATE TABLE {t} (A NUMBER, B VARCHAR2(20), C CHAR(5), D DATE)",
            $"INSERT INTO {t} VALUES (1, 'x', 'ab', TO_DATE('2026-01-02 13:14:15','YYYY-MM-DD HH24:MI:SS'))",
            $"INSERT INTO {t} VALUES (1, 'x', 'ab', TO_DATE('2026-01-02 13:14:15','YYYY-MM-DD HH24:MI:SS'))",
        ]);
        try
        {
            await using var session = await fixture.OpenSessionAsync();
            // The data tab's page: ROWID as the last column (a string), ordered by ROWID.
            var (page, sink) = await ExecAsync(session, $"SELECT {t}.*, ROWID\nFROM {t}\nORDER BY ROWID\nOFFSET 0 ROWS FETCH NEXT 1000 ROWS ONLY");
            Assert.Equal(ExecutionStatus.Ok, page.Status);
            var rs = sink.ResultSets.Single();
            Assert.Equal(["A", "B", "C", "D", "ROWID"], rs.Columns.Select(c => c.Name));
            Assert.Equal(ColumnKinds.String, rs.Columns[4].Kind);
            var second = (string)rs.Rows[1][4]!;

            var r = await SubmitAsync(session, new Stmt($"UPDATE {t} SET B = :p1, D = :p2 WHERE ROWID = :p3 AND B = :p4 AND D = :p5",
                [P("p1", "string", "second"), P("p2", "datetime", "2027-01-01T10:00:00"), P("p3", "string", second), P("p4", "string", "x"), P("p5", "datetime", "2026-01-02T13:14:15")]));
            Assert.True(r.Ok, r.Error);
            Assert.Equal(1, r.Results[0].RowsAffected);
            Assert.Equal(["x", "second"], (await CommittedRowsAsync($"SELECT B FROM {t} ORDER BY ROWID")).Select(x => x[0]));

            // INSERT returns the new ROWID (out bind, string), which the refetch then reads back.
            r = await SubmitAsync(session, new Stmt($"INSERT INTO {t} (A, B) VALUES (:p1, :p2) RETURNING ROWID INTO :out1",
                [P("p1", "int", 9L), P("p2", "string", "new"), Out("out1", "string")], ExpectOne: false));
            Assert.True(r.Ok, r.Error);
            var newRowid = Assert.IsType<string>(Assert.Single(r.Results[0].OutParams!).Value);
            var (refetch, rsink) = await ExecAsync(session, $"SELECT {t}.*, ROWID\nFROM {t}\nWHERE ROWID = :k1", [P("k1", "string", newRowid)]);
            Assert.Equal(ExecutionStatus.Ok, refetch.Status);
            Assert.Equal(["9", "new", null, null, newRowid], rsink.ResultSets.Single().Rows.Single());

            // Nothing typed: one column set to DEFAULT.
            r = await SubmitAsync(session, new Stmt($"INSERT INTO {t} (A) VALUES (DEFAULT) RETURNING ROWID INTO :out1", [Out("out1", "string")], ExpectOne: false));
            Assert.True(r.Ok, r.Error);

            // DELETE by ROWID with the original values (CHAR padded, NULLs as IS NULL).
            r = await SubmitAsync(session, new Stmt($"DELETE FROM {t} WHERE ROWID = :p1 AND A = :p2 AND B = :p3 AND C = :p4", [P("p1", "string", second), P("p2", "decimal", "1"), P("p3", "string", "second"), P("p4", "string", "ab   ")]));
            Assert.True(r.Ok, r.Error);
            Assert.Equal(3m, Convert.ToDecimal((await CommittedRowsAsync($"SELECT COUNT(*) FROM {t}")).Single()[0]));
            Assert.Equal(["x"], (await CommittedRowsAsync($"SELECT B FROM {t} WHERE A = 1")).Select(x => x[0]));
        }
        finally
        {
            await DropAsync(t);
        }
    }

    [SkippableFact]
    public async Task QuotedLowerCaseAndReservedNames_CompositeKey_IdentityAlways()
    {
        RequireAvailable();
        var lower = $"ed_lower_{_id.ToLowerInvariant()}";
        var ident = T("IDENT");
        await fixture.RunBatchesAsync([
            $"CREATE TABLE \"{lower}\" (\"id\" NUMBER(10), \"Name\" VARCHAR2(20), \"COMMENT\" VARCHAR2(20), K2 VARCHAR2(5), CONSTRAINT \"pk_{lower}\" PRIMARY KEY (\"id\", K2))",
            $"INSERT INTO \"{lower}\" VALUES (1, 'a', 'c1', 'x')",
            $"CREATE TABLE {ident} (ID NUMBER(10) GENERATED ALWAYS AS IDENTITY PRIMARY KEY, V VARCHAR2(10), VIRT NUMBER GENERATED ALWAYS AS (LENGTH(V)) VIRTUAL)",
        ]);
        try
        {
            await using var session = await fixture.OpenSessionAsync();
            var r = await SubmitAsync(session,
                new Stmt($"UPDATE \"{lower}\" SET \"Name\" = :p1, \"COMMENT\" = :p2 WHERE \"id\" = :p3 AND K2 = :p4", [P("p1", "string", "b"), P("p2", "string", "c2"), P("p3", "int", 1L), P("p4", "string", "x")]),
                new Stmt($"INSERT INTO \"{lower}\" (\"id\", \"Name\", K2) VALUES (:p1, :p2, :p3)", [P("p1", "int", 1L), P("p2", "string", "z"), P("p3", "string", "y")], ExpectOne: false));
            Assert.True(r.Ok, r.Error);
            Assert.Equal([["b", "c2"], ["z", null]], (await CommittedRowsAsync($"SELECT \"Name\", \"COMMENT\" FROM \"{lower}\" ORDER BY K2")).Select(x => x.ToArray()));

            // GENERATED ALWAYS identity: left out of the INSERT, its value returned; the catalog flags it read-only (8).
            r = await SubmitAsync(session, new Stmt($"INSERT INTO {ident} (V) VALUES (:p1) RETURNING ID INTO :out1", [P("p1", "string", "abc"), Out("out1", "decimal")], ExpectOne: false));
            Assert.True(r.Ok, r.Error);
            Assert.Equal("1", Assert.Single(r.Results[0].OutParams!).Value);
            await using var catalog = await fixture.OpenCatalogAsync();
            var schema = await catalog.LoadSchemaAsync(null, fixture.ShopSchema, CancellationToken.None);
            var cols = schema.Objects.Single(o => o.Name == ident).Columns;
            Assert.Equal(1 | 8, cols.Single(c => c.Name == "ID").Flags);
            Assert.Equal(2, cols.Single(c => c.Name == "VIRT").Flags);
            Assert.Equal(0, cols.Single(c => c.Name == "V").Flags);
        }
        finally
        {
            await DropAsync($"\"{lower}\"", ident);
        }
    }

    [SkippableFact]
    public async Task OtherSchemaTable_IsEditedWithItsOwnerPrefix()
    {
        RequireAvailable();
        Skip.If(fixture.Endpoint?.SystemPassword is null, "Needs the SYSTEM password to create a second schema.");
        var owner = $"ED_OTHER_{_id}";
        var admin = OracleBackend.Profile(fixture.Endpoint!, "system", "c_it_oracle_admin");
        async Task AdminAsync(params string[] sql)
        {
            await using var s = await fixture.Provider.OpenSessionAsync(admin, fixture.Endpoint!.SystemPassword, new SessionOptions("s_ed_admin", null, TransactionMode.Auto, false), CancellationToken.None);
            foreach (var q in sql)
            {
                var (summary, sink) = await ExecAsync(s, q);
                Assert.True(summary.Status == ExecutionStatus.Ok, q + ": " + string.Join("; ", sink.Errors.Select(e => e.Error.Message)));
            }
        }
        await AdminAsync(
            $"CREATE USER {owner} IDENTIFIED BY \"Ed_{_id}_x1\" QUOTA UNLIMITED ON USERS",
            $"CREATE TABLE {owner}.ITEMS (ID NUMBER PRIMARY KEY, LABEL VARCHAR2(20))",
            $"INSERT INTO {owner}.ITEMS VALUES (1, 'one')",
            $"CREATE TABLE {owner}.HEAP (LABEL VARCHAR2(20))",
            $"INSERT INTO {owner}.HEAP VALUES ('h')",
            $"GRANT SELECT, INSERT, UPDATE, DELETE ON {owner}.ITEMS TO {OracleBackend.AppUser}",
            $"GRANT SELECT, INSERT, UPDATE, DELETE ON {owner}.HEAP TO {OracleBackend.AppUser}");
        try
        {
            await using var session = await fixture.OpenSessionAsync();
            var (_, sink) = await ExecAsync(session, $"SELECT {owner}.HEAP.*, ROWID\nFROM {owner}.HEAP");
            var rowid = (string)sink.ResultSets.Single().Rows.Single()[1]!;
            var r = await SubmitAsync(session,
                new Stmt($"UPDATE {owner}.ITEMS SET LABEL = :p1 WHERE ID = :p2", [P("p1", "string", "uno"), P("p2", "int", 1L)]),
                new Stmt($"UPDATE {owner}.HEAP SET LABEL = :p1 WHERE ROWID = :p2", [P("p1", "string", "h2"), P("p2", "string", rowid)]),
                new Stmt($"DELETE FROM {owner}.ITEMS WHERE ID = :p1", [P("p1", "int", 1L)]));
            Assert.True(r.Ok, r.Error);
            Assert.Empty(await CommittedRowsAsync($"SELECT * FROM {owner}.ITEMS"));
            Assert.Equal("h2", (await CommittedRowsAsync($"SELECT LABEL FROM {owner}.HEAP")).Single()[0]);
        }
        finally
        {
            await AdminAsync($"DROP USER {owner} CASCADE");
        }
    }

    [SkippableFact]
    public async Task ManualMode_SaveWithSavepoint_StaysOpenUntilCommit()
    {
        // A grid save into a console that has an open transaction: SAVEPOINT dbs_edit, the statements, nothing committed.
        RequireAvailable();
        var t = T("TX");
        await fixture.RunBatchesAsync([$"CREATE TABLE {t} (ID NUMBER PRIMARY KEY, V VARCHAR2(10))", $"INSERT INTO {t} VALUES (1, 'a')"]);
        try
        {
            await using var session = await fixture.OpenSessionAsync(TransactionMode.Manual);
            Assert.Equal(ExecutionStatus.Ok, (await ExecAsync(session, $"INSERT INTO {t} VALUES (2, 'user')")).Summary.Status);
            Assert.True(session.TxOpen);
            Assert.Equal(ExecutionStatus.Ok, (await ExecAsync(session, "SAVEPOINT dbs_edit")).Summary.Status);
            var (upd, _) = await ExecAsync(session, $"UPDATE {t} SET V = :p1 WHERE ID = :p2 AND V = :p3", [P("p1", "string", "b"), P("p2", "int", 1L), P("p3", "string", "a")]);
            Assert.Equal(1, upd.RowsAffected);
            Assert.Equal("a", (await CommittedRowsAsync($"SELECT V FROM {t} WHERE ID = 1")).Single()[0]);
            // A failed save rolls back to the savepoint only: the user's own INSERT stays.
            Assert.Equal(ExecutionStatus.Ok, (await ExecAsync(session, "ROLLBACK TO SAVEPOINT dbs_edit")).Summary.Status);
            await session.CommitAsync(CancellationToken.None);
            Assert.Equal([["a"], ["user"]], (await CommittedRowsAsync($"SELECT V FROM {t} ORDER BY ID")).Select(x => x.ToArray()));
        }
        finally
        {
            await DropAsync(t);
        }
    }

    [SkippableFact]
    public async Task Designer_AltersStoredLowerCaseTable_ByItsExactNames()
    {
        RequireAvailable();
        var name = $"ed_dz_{_id.ToLowerInvariant()}";
        await fixture.RunBatchesAsync([$"CREATE TABLE \"{name}\" (\"id\" NUMBER(10) PRIMARY KEY, \"Name\" VARCHAR2(20), \"select\" VARCHAR2(10))", $"INSERT INTO \"{name}\" VALUES (1, 'a', 's')"]);
        var db = new OracleDesignerDatabase();
        var scripter = new OracleDdlScripter();
        try
        {
            var original = await db.ReadTableAsync(fixture.Profile, fixture.Password, null, fixture.ShopSchema, name, CancellationToken.None);
            Assert.Equal(name, original.Name);
            var desired = original with
            {
                Comment = "lower",
                Columns =
                [
                    original.Columns[0],
                    original.Columns[1] with { Name = "full_name", Type = "VARCHAR2(60)", Comment = "renamed" },
                    new TableColumnModel { Name = "amount", Type = "NUMBER(10,2)", Default = "0", Nullable = false },
                ],
                Uniques = [new UniqueModel { Name = $"UQ_{_id}", Columns = ["full_name"] }],
                Checks = [new CheckModel { Name = $"CK_{_id}", Expression = "amount >= 0" }],
            };
            var context = await db.GetScriptContextAsync(fixture.Profile, fixture.Password, null, fixture.ShopSchema, name, CancellationToken.None);
            var script = scripter.ScriptTable(original, desired, context);
            Assert.All(script.Statements, s => Assert.DoesNotContain(";", s.Sql.TrimEnd()[^1..]));
            Assert.Contains(script.Statements, s => s.Sql == $"ALTER TABLE {fixture.ShopSchema}.\"{name}\" DROP COLUMN \"select\"");
            await db.ApplyAsync(fixture.Profile, fixture.Password, new DdlApplyRequest(null, script.Statements.Select(s => s.Sql).ToList(), script.Transactional, fixture.ShopSchema), CancellationToken.None);

            var read = await db.ReadTableAsync(fixture.Profile, fixture.Password, null, fixture.ShopSchema, name, CancellationToken.None);
            Assert.Equal(["id", "FULL_NAME", "AMOUNT"], read.Columns.Select(c => c.Name));
            Assert.Equal("lower", read.Comment);
            Assert.Equal("renamed", read.Columns[1].Comment);
            Assert.Equal("a", (await CommittedRowsAsync($"SELECT FULL_NAME FROM \"{name}\"")).Single()[0]);
            // Read back and scripted again: nothing left to change.
            Assert.Empty(scripter.ScriptTable(read, read, context).Statements);

            // Rename the table itself: a newly typed name folds to upper case like an unquoted Oracle name.
            var renamed = scripter.ScriptTable(read, read with { Name = name + "_r" }, context);
            Assert.Equal($"ALTER TABLE {fixture.ShopSchema}.\"{name}\" RENAME TO {name.ToUpperInvariant()}_R", Assert.Single(renamed.Statements).Sql);
            await db.ApplyAsync(fixture.Profile, fixture.Password, new DdlApplyRequest(null, renamed.Statements.Select(s => s.Sql).ToList(), false, fixture.ShopSchema), CancellationToken.None);
            Assert.Equal(name.ToUpperInvariant() + "_R", (await db.ReadTableAsync(fixture.Profile, fixture.Password, null, fixture.ShopSchema, name.ToUpperInvariant() + "_R", CancellationToken.None)).Name);
        }
        finally
        {
            await DropAsync($"\"{name}\"", name.ToUpperInvariant() + "_R");
        }
    }
}

/// <summary>
/// Test classes that create, alter or drop scratch tables in SHOP, and the schema-wide Find in database, which reads every
/// table of SHOP: run one after the other, or a search can meet a table or column being dropped (ORA-00904/00942).
/// </summary>
[CollectionDefinition(Name)]
public sealed class ShopSchemaWriters
{
    public const string Name = "Oracle SHOP schema writers";
}
