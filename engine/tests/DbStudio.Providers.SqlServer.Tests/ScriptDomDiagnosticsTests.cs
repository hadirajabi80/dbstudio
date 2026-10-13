using DbStudio.Providers.SqlServer.TSql;

namespace DbStudio.Providers.SqlServer.Tests;

public sealed class ScriptDomDiagnosticsTests
{
    [Fact]
    public void PicksHighestParserAvailable()
    {
        Assert.True(ScriptDomDiagnostics.ParserVersion >= 160, ScriptDomDiagnostics.ParserName);
        Assert.Equal($"TSql{ScriptDomDiagnostics.ParserVersion}Parser", ScriptDomDiagnostics.ParserName);
        Assert.Equal(ScriptDomDiagnostics.ParserName, ScriptDomDiagnostics.CreateParser().GetType().Name);
    }

    [Fact]
    public async Task ProviderExposesScriptDomEngine()
    {
        var diagnostics = new SqlServerProvider().Diagnostics;
        Assert.NotNull(diagnostics);
        Assert.Equal("scriptdom", diagnostics!.EngineName);
        Assert.Empty(await diagnostics.AnalyzeAsync("SELECT 1", null, null, CancellationToken.None));
    }

    [Fact]
    public void ValidScript_HasNoDiagnostics() =>
        Assert.Empty(ScriptDomDiagnostics.Analyze("SELECT a, b FROM dbo.T WHERE a = 1;\nGO\nCREATE PROCEDURE p AS SELECT 1;\nGO\n"));

    [Fact]
    public void SingleError_IsOneBased_WithTokenEnd()
    {
        var d = Assert.Single(ScriptDomDiagnostics.Analyze("SELECT * FORM t"));
        Assert.Equal(1, d.Line);
        Assert.Equal("error", d.Severity);
        Assert.StartsWith("SQL", d.Code);
        Assert.True(d.Col >= 1);
        Assert.True(d.EndCol > d.Col);
        Assert.Equal(d.Line, d.EndLine);
    }

    [Fact]
    public void ErrorPositions_AreAbsoluteAcrossGoBatches()
    {
        const string sql =
            "SELECT 1;\n" +          // 1
            "GO\n" +                 // 2
            "SELECT 2;\n" +          // 3
            "GO\n" +                 // 4
            "\n" +                   // 5
            "SELECT * FROM\n" +      // 6
            "GO\n" +                 // 7
            "SELECT 3 FROM t WHERE"; // 8
        var diags = ScriptDomDiagnostics.Analyze(sql);
        Assert.Equal(2, diags.Count);
        Assert.InRange(diags[0].Line, 6, 7);  // error at end of "SELECT * FROM" (reported at EOF of that batch)
        Assert.Equal(8, diags[1].Line);
        Assert.All(diags, d => Assert.True(d.Col >= 1));
    }

    [Fact]
    public void ErrorColumn_PointsAtOffendingToken()
    {
        const string sql = "SELECT 1\nGO\nSELECT a FROM t WHERE a = = 1";
        var d = Assert.Single(ScriptDomDiagnostics.Analyze(sql));
        Assert.Equal(3, d.Line);
        Assert.Equal("SELECT a FROM t WHERE a = = 1".IndexOf("= 1", StringComparison.Ordinal) + 1, d.Col);
    }

    [Fact]
    public void ErrorsInEveryBatch_AreReported()
    {
        // ("SELEC 1" would be valid: a bare procedure call as the first statement of a batch.)
        var diags = ScriptDomDiagnostics.Analyze("SELECT 1 FROM WHERE\nGO\nSELECT (2 FROM t\nGO 3\nSELECT 3 FROM WHERE");
        Assert.Equal(new[] { 1, 3, 5 }, diags.Select(d => d.Line));
    }

    [Fact]
    public void GoInsideStringOrComment_DoesNotSplit()
    {
        const string sql = "SELECT '\nGO\n' AS s;\n/* \nGO\n */ SELECT 1;";
        Assert.Empty(ScriptDomDiagnostics.Analyze(sql));
        Assert.Single(BatchSplitter.Split(sql));
    }

    [Fact]
    public void QuotedIdentifiers_AreOn()
    {
        Assert.Empty(ScriptDomDiagnostics.Analyze("SELECT \"a b\" FROM \"my table\""));
    }

    [Fact]
    public void CrLfLineEndings_KeepPositions()
    {
        var d = Assert.Single(ScriptDomDiagnostics.Analyze("SELECT 1\r\nGO\r\nSELECT * FORM t\r\n"));
        Assert.Equal(3, d.Line);
    }

    [Fact]
    public void Cancellation_IsHonoured() =>
        Assert.Throws<OperationCanceledException>(() => ScriptDomDiagnostics.Analyze("SELECT 1", new CancellationToken(true)));
}

public sealed class BatchSplitterTests
{
    [Fact]
    public void Splits_OnGoLines_WithStartLines()
    {
        var b = BatchSplitter.Split("SELECT 1\nGO\nSELECT 2\nselect 3\n  go  \nSELECT 4");
        Assert.Equal(3, b.Count);
        Assert.Equal((1, "SELECT 1\n"), (b[0].StartLine, b[0].Text));
        Assert.Equal((3, "SELECT 2\nselect 3\n"), (b[1].StartLine, b[1].Text));
        Assert.Equal((6, "SELECT 4"), (b[2].StartLine, b[2].Text));
    }

    [Fact]
    public void GoWithCount_AndTrailingComment()
    {
        var b = BatchSplitter.Split("INSERT t VALUES (1)\nGO 5 -- five times\nSELECT 1");
        Assert.Equal(2, b.Count);
        Assert.Equal(5, b[0].RepeatCount);
        Assert.Equal(1, b[1].RepeatCount);
        Assert.Equal(3, b[1].StartLine);
    }

    [Theory]
    [InlineData("SELECT 'a\nGO\nb'")]
    [InlineData("SELECT [a\nGO\nb] FROM t")]
    [InlineData("SELECT \"a\nGO\nb\" FROM t")]
    [InlineData("/* outer /* nested\nGO\n */ still comment\nGO\n*/ SELECT 1")]
    [InlineData("SELECT 1 -- GO\nSELECT 2")]
    [InlineData("SELECT 'it''s\nGO\n'")]
    [InlineData("SELECT 1 GO")]
    [InlineData("GOTO label")]
    public void DoesNotSplit_InsideTokensOrPartialLines(string sql) => Assert.Single(BatchSplitter.Split(sql));

    [Fact]
    public void Offsets_PointAtBatchStart()
    {
        const string sql = "A\r\nGO\r\nB";
        var b = BatchSplitter.Split(sql);
        Assert.Equal(2, b.Count);
        Assert.Equal("B", sql[b[1].Offset..]);
        Assert.Equal(3, b[1].StartLine);
    }

    [Fact]
    public void EmptyDocument_IsOneEmptyBatch() => Assert.Equal("", Assert.Single(BatchSplitter.Split("")).Text);
}
