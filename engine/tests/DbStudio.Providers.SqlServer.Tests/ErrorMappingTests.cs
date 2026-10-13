using DbStudio.Core.Models;
using static DbStudio.Providers.SqlServer.SqlServerErrors;

namespace DbStudio.Providers.SqlServer.Tests;

public sealed class ErrorMappingTests
{
    private static readonly SqlBatch Batch = new("SELECT 1;\nSELECT x FROM t;", 10, 1);

    [Fact]
    public void BatchRelativeLine_BecomesDocumentLine()
    {
        var e = new ServerError(207, 16, 1, 2, null, "Invalid column name 'x'.");
        var info = ToErrorInfo(e, Batch);
        Assert.Equal("207", info.Code);
        Assert.Equal(207, info.ProviderCode);
        Assert.Equal(11, info.Line);
        Assert.Equal(1, info.State);
        Assert.Null(info.Col);
        Assert.Equal("Msg 207, Level 16, State 1, Line 2", info.Detail);
        Assert.Equal("Invalid column name 'x'.", info.Message);
    }

    [Fact]
    public void ErrorInsideCalledProcedure_HasNoDocumentLine()
    {
        var e = new ServerError(50000, 16, 1, 42, "usp_Other", "boom");
        Assert.Null(DocumentLine(e, new SqlBatch("EXEC dbo.usp_Other", 5, 1)));
        Assert.Equal("Msg 50000, Level 16, State 1, Procedure usp_Other, Line 42", Header(e));
    }

    [Theory]
    [InlineData("CREATE PROCEDURE dbo.usp_Test AS SELECT 1", "usp_Test")]
    [InlineData("create or alter proc [dbo].[usp_Test] as select 1", "usp_Test")]
    [InlineData("ALTER FUNCTION usp_Test() RETURNS INT AS BEGIN RETURN 1 END", "usp_Test")]
    [InlineData("CREATE TRIGGER sales.\"usp_Test\" ON t AFTER INSERT AS SELECT 1", "usp_Test")]
    [InlineData("CREATE VIEW db.dbo.usp_Test AS SELECT 1", "USP_TEST")]
    public void CompileErrorInBatchDefinedModule_KeepsBatchLine(string sql, string procedure)
    {
        Assert.True(BatchDefinesModule(sql, procedure));
        var e = new ServerError(102, 15, 1, 3, procedure, "Incorrect syntax");
        Assert.Equal(7, DocumentLine(e, new SqlBatch(sql, 5, 1)));
    }

    [Theory]
    [InlineData("EXEC dbo.usp_Test", "usp_Test")]
    [InlineData("CREATE PROCEDURE dbo.usp_Test2 AS SELECT 1", "usp_Test")]
    [InlineData("CREATE TABLE usp_Test (id int)", "usp_Test")]
    public void OtherBatches_DoNotDefineModule(string sql, string procedure) => Assert.False(BatchDefinesModule(sql, procedure));

    [Fact]
    public void LineZero_IsUnknown() => Assert.Null(DocumentLine(new ServerError(0, 0, 0, 0, null, "x"), Batch));

    [Theory]
    [InlineData(0, false)]
    [InlineData(10, false)]
    [InlineData(11, true)]
    [InlineData(16, true)]
    [InlineData(20, true)]
    public void Severity_Threshold(byte cls, bool isError) => Assert.Equal(isError, IsError(new ServerError(1, cls, 1, 1, null, "m")));

    [Fact]
    public void ProviderError_ForNonSqlException()
    {
        var info = SqlServerProvider.ToProviderError(new ArgumentException("Server is required."));
        Assert.Equal("PROVIDER_ERROR", info.Code);
        Assert.Equal("Server is required.", info.Message);
    }
}
