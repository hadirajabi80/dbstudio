using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.SqlServer.Tests;

/// <summary>Per-statement kinds for StatementCompleted counts (no server needed).</summary>
public sealed class StatementKindTests
{
    private static BatchClassification C(string sql) => StatementClassifier.Classify(sql, Dialect.TSql);

    [Fact]
    public void DmlStatements_AreAssignedInOrder()
    {
        var c = C("INSERT INTO t VALUES (1); SELECT * FROM t; UPDATE t SET a = 2; DELETE FROM t;");
        Assert.Equal("INSERT", SqlServerSession.StatementKindFor(c, 0));
        Assert.Equal("UPDATE", SqlServerSession.StatementKindFor(c, 1));
        Assert.Equal("DELETE", SqlServerSession.StatementKindFor(c, 2));
        Assert.Null(SqlServerSession.StatementKindFor(c, 3));
    }

    [Fact]
    public void ExtraCompletions_OfASingleKind_KeepThatKind() =>
        Assert.Equal("UPDATE", SqlServerSession.StatementKindFor(C("UPDATE t SET a = 1"), 5));

    [Fact]
    public void ProcedureCalls_MakeKindsUnknown() =>
        Assert.Null(SqlServerSession.StatementKindFor(C("EXEC dbo.p; UPDATE t SET a = 1"), 0));
}
