using DbStudio.Core.Designer;

namespace DbStudio.Core.Tests.M15;

/// <summary>TableDiff (docs/PLAN-M1.5.md 1.3.1): 20+ cases over a small "Customers" model.</summary>
public sealed class TableDiffTests
{
    internal static TableColumnModel Col(string name, string type = "int", bool nullable = true, string? def = null, string? id = null) =>
        new() { Id = id ?? name, Name = name, Type = type, Nullable = nullable, Default = def };

    internal static TableModel Customers() => new()
    {
        Schema = "dbo",
        Name = "Customers",
        Columns =
        [
            Col("Id", "int", false) with { Identity = new IdentityModel(1, 1) },
            Col("Name", "nvarchar(100)", false),
            Col("Email", "nvarchar(200)"),
            Col("CountryId", "int"),
            Col("CreatedAt", "datetime2(3)", false, "SYSUTCDATETIME()") with { DefaultName = "DF_Customers_CreatedAt" },
        ],
        PrimaryKey = new PrimaryKeyModel { Name = "PK_Customers", Columns = ["Id"], Clustered = true },
        Uniques = [new UniqueModel { Name = "UQ_Customers_Email", Columns = ["Email"] }],
        Indexes = [new IndexModel { Name = "IX_Customers_Name", Columns = [new IndexColumnModel("Name")] }],
        ForeignKeys = [new ForeignKeyModel { Name = "FK_Customers_Countries", Columns = ["CountryId"], RefSchema = "dbo", RefTable = "Countries", RefColumns = ["Id"] }],
        Checks = [new CheckModel { Name = "CK_Customers_Name", Expression = "len([Name]) > 0" }],
    };

    private static TableModel WithColumns(TableModel t, Func<List<TableColumnModel>, List<TableColumnModel>> edit) => t with { Columns = edit(t.Columns.ToList()) };

    private static List<string> Kinds(TableDiffResult d) => d.Changes.Select(c => c.Kind).ToList();

    [Fact]
    public void Create_WhenOriginalIsNull()
    {
        var d = TableDiff.Compute(null, Customers());
        Assert.True(d.IsCreate);
        Assert.Equal(5, d.Added.Count);
        Assert.NotNull(d.PrimaryKeyAdded);
        Assert.Single(d.IndexesAdded);
        Assert.Empty(d.Changes);
    }

    [Fact]
    public void Identical_IsEmpty()
    {
        var d = TableDiff.Compute(Customers(), Customers());
        Assert.True(d.IsEmpty);
        Assert.False(d.ColumnsReordered);
    }

    [Fact]
    public void AddColumn()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => [.. c, Col("Phone", "varchar(30)", id: "new_1")]));
        Assert.Equal("Phone", Assert.Single(d.Added).Name);
        Assert.Equal([TableChangeKinds.ColumnAdded], Kinds(d));
    }

    [Fact]
    public void DropColumn()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Where(x => x.Name != "Email").ToList()) with { Uniques = [] });
        Assert.Equal("Email", Assert.Single(d.Dropped).Name);
        Assert.Contains(TableChangeKinds.ColumnDropped, Kinds(d));
        Assert.Contains(TableChangeKinds.UniqueDropped, Kinds(d));
    }

    [Fact]
    public void RenameColumn_ById_IsNotDropPlusAdd()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Email" ? x with { Name = "EmailAddress" } : x).ToList())
            with { Uniques = [new UniqueModel { Name = "UQ_Customers_Email", Columns = ["EmailAddress"] }] });
        Assert.Empty(d.Added);
        Assert.Empty(d.Dropped);
        var renamed = Assert.Single(d.Renamed);
        Assert.Equal("Email", renamed.Old.Name);
        Assert.Equal("EmailAddress", renamed.New.Name);
        // The unique constraint follows the rename: not dropped and re-added.
        Assert.Empty(d.UniquesDropped);
        Assert.Equal([TableChangeKinds.ColumnRenamed], Kinds(d));
        Assert.Equal("EmailAddress", d.NewNameOf("email"));
    }

    [Fact]
    public void RenameColumn_WithoutId_IsDropPlusAdd()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "CountryId" ? x with { Name = "Country", Id = null } : x).ToList())
            with { ForeignKeys = [] });
        Assert.Equal("Country", Assert.Single(d.Added).Name);
        Assert.Equal("CountryId", Assert.Single(d.Dropped).Name);
    }

    [Fact]
    public void ChangeType_IgnoresCaseAndWhitespace()
    {
        var same = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Name" ? x with { Type = "NVARCHAR (100)" } : x).ToList()));
        Assert.True(same.IsEmpty);
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Name" ? x with { Type = "nvarchar(50)" } : x).ToList()));
        var m = Assert.Single(d.Redefined);
        Assert.True(m.TypeChanged);
        Assert.Equal([TableChangeKinds.ColumnTypeChanged], Kinds(d));
    }

    [Fact]
    public void ChangeNullability()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Email" ? x with { Nullable = false } : x).ToList()));
        Assert.True(Assert.Single(d.Redefined).NullabilityChanged);
        Assert.Equal("NOT NULL", d.Changes.Single().Detail);
    }

    [Fact]
    public void ChangeDefault_ParenthesesAreNotAChange()
    {
        var same = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "CreatedAt" ? x with { Default = "((sysutcdatetime()))" } : x).ToList()));
        Assert.True(same.IsEmpty);
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "CreatedAt" ? x with { Default = "GETDATE()" } : x).ToList()));
        Assert.True(Assert.Single(d.Redefined).DefaultChanged);
    }

    [Fact]
    public void DropDefault()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "CreatedAt" ? x with { Default = null } : x).ToList()));
        Assert.Equal(TableChangeKinds.ColumnDefaultChanged, d.Changes.Single().Kind);
        Assert.Equal("(none)", d.Changes.Single().Detail);
    }

    [Fact]
    public void StringDefault_CaseInsideLiteralMatters()
    {
        var t = WithColumns(Customers(), c => c.Select(x => x.Name == "Name" ? x with { Default = "N'Anon'" } : x).ToList());
        Assert.True(TableDiff.Compute(t, WithColumns(t, c => c.Select(x => x.Name == "Name" ? x with { Default = "n'Anon'" } : x).ToList())).IsEmpty);
        Assert.False(TableDiff.Compute(t, WithColumns(t, c => c.Select(x => x.Name == "Name" ? x with { Default = "N'anon'" } : x).ToList())).IsEmpty);
    }

    [Fact]
    public void ChangeIdentity()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Id" ? x with { Identity = new IdentityModel(1000, 1) } : x).ToList()));
        Assert.True(Assert.Single(d.Redefined).IdentityChanged);
        Assert.Equal([TableChangeKinds.ColumnIdentityChanged], Kinds(d));
    }

    [Fact]
    public void ReorderColumns()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => [c[1], c[0], .. c.Skip(2)]));
        Assert.True(d.ColumnsReordered);
        Assert.Equal([TableChangeKinds.ColumnsReordered], Kinds(d));
    }

    [Fact]
    public void AddAndDropIndex()
    {
        var d = TableDiff.Compute(Customers(), Customers() with
        {
            Indexes = [new IndexModel { Name = "IX_Customers_Email", Columns = [new IndexColumnModel("Email", Desc: true)], Include = ["Name"] }],
        });
        Assert.Equal("IX_Customers_Name", Assert.Single(d.IndexesDropped).Name);
        Assert.Equal("IX_Customers_Email", Assert.Single(d.IndexesAdded).Name);
    }

    [Fact]
    public void ChangedIndex_IsDropPlusAdd()
    {
        var d = TableDiff.Compute(Customers(), Customers() with
        {
            Indexes = [new IndexModel { Name = "IX_Customers_Name", Columns = [new IndexColumnModel("Name", Desc: true)] }],
        });
        Assert.Single(d.IndexesDropped);
        Assert.Single(d.IndexesAdded);
        Assert.Equal([TableChangeKinds.IndexDropped, TableChangeKinds.IndexAdded], Kinds(d));
    }

    [Fact]
    public void AddForeignKey_ChangedActionIsDropPlusAdd()
    {
        var d = TableDiff.Compute(Customers(), Customers() with
        {
            ForeignKeys = [Customers().ForeignKeys[0] with { OnDelete = "cascade" }],
        });
        Assert.Single(d.ForeignKeysDropped);
        Assert.Equal("CASCADE", ReferentialActions.Normalize(Assert.Single(d.ForeignKeysAdded).OnDelete));
    }

    [Fact]
    public void ForeignKey_NullRefSchemaMatchesAnySchema()
    {
        var d = TableDiff.Compute(Customers(), Customers() with { ForeignKeys = [Customers().ForeignKeys[0] with { RefSchema = null }] });
        Assert.True(d.IsEmpty);
    }

    [Fact]
    public void PrimaryKeyChange_IsDropPlusAdd()
    {
        var d = TableDiff.Compute(Customers(), Customers() with { PrimaryKey = new PrimaryKeyModel { Name = "PK_Customers", Columns = ["Id", "Name"] } });
        Assert.NotNull(d.PrimaryKeyDropped);
        Assert.Equal(["Id", "Name"], d.PrimaryKeyAdded!.Columns);
    }

    [Fact]
    public void UnnamedDesiredConstraint_MatchesNamedOriginal()
    {
        var d = TableDiff.Compute(Customers(), Customers() with
        {
            PrimaryKey = new PrimaryKeyModel { Name = null, Columns = ["Id"] },
            Uniques = [new UniqueModel { Name = null, Columns = ["Email"] }],
            Checks = [new CheckModel { Name = null, Expression = "LEN([Name])>0" }],
        });
        Assert.True(d.IsEmpty, string.Join(", ", Kinds(d)));
    }

    [Fact]
    public void CheckChanged_AndCheckFollowsColumnRename()
    {
        var changed = TableDiff.Compute(Customers(), Customers() with { Checks = [new CheckModel { Name = "CK_Customers_Name", Expression = "len([Name]) > 1" }] });
        Assert.Single(changed.ChecksDropped);
        Assert.Single(changed.ChecksAdded);

        var renamed = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Name" ? x with { Name = "FullName" } : x).ToList()) with
        {
            Indexes = [new IndexModel { Name = "IX_Customers_Name", Columns = [new IndexColumnModel("FullName")] }],
            Checks = [new CheckModel { Name = "CK_Customers_Name", Expression = "len([FullName]) > 0" }],
        });
        Assert.Equal([TableChangeKinds.ColumnRenamed], Kinds(renamed));
    }

    [Fact]
    public void TableRename_AndCommentChange()
    {
        var d = TableDiff.Compute(Customers(), Customers() with { Name = "Clients", Comment = "People who buy" });
        Assert.True(d.TableRenamed);
        Assert.True(d.CommentChanged);
        Assert.Equal([TableChangeKinds.TableRenamed, TableChangeKinds.TableCommentChanged], Kinds(d));
    }

    [Fact]
    public void ColumnCommentAndCollation()
    {
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Name" ? x with { Comment = "Display name", Collation = "Latin1_General_CS_AS" } : x).ToList()));
        Assert.Equal([TableChangeKinds.ColumnCollationChanged, TableChangeKinds.ColumnCommentChanged], Kinds(d));
        Assert.True(d.Matched.Single(m => m.New.Name == "Name").DefinitionChanged);
    }

    [Fact]
    public void ComputedColumnChange()
    {
        var t = WithColumns(Customers(), c => [.. c, new TableColumnModel { Id = "Label", Name = "Label", Computed = new ComputedModel("[Name] + N' <' + [Email] + N'>'") }]);
        Assert.True(TableDiff.Compute(t, t).IsEmpty);
        var d = TableDiff.Compute(t, WithColumns(t, c => c.Select(x => x.Name == "Label" ? x with { Computed = x.Computed! with { Persisted = true } } : x).ToList()));
        Assert.Equal([TableChangeKinds.ColumnComputedChanged], Kinds(d));
    }

    [Fact]
    public void OptionsChange()
    {
        var d = TableDiff.Compute(Customers(), Customers() with { Options = new TableOptions { WithoutRowid = true } });
        Assert.True(d.OptionsChanged);
    }

    [Fact]
    public void NewColumnWithFreshId_ReusingDroppedName_MatchesByName()
    {
        // The user deleted Email and added a new "Email" row: same column, retyped (no data loss).
        var d = TableDiff.Compute(Customers(), WithColumns(Customers(), c => c.Select(x => x.Name == "Email" ? Col("Email", "varchar(320)", id: "new_7") : x).ToList()));
        Assert.Empty(d.Added);
        Assert.Empty(d.Dropped);
        Assert.True(Assert.Single(d.Redefined).TypeChanged);
    }

    [Theory]
    [InlineData("((0))", "0")]
    [InlineData("(getdate())", "getdate()")]
    [InlineData("(a) + (b)", "(a) + (b)")]
    [InlineData("  ('x')  ", "'x'")]
    public void StripOuterParens(string input, string expected) => Assert.Equal(expected, TableDiff.StripOuterParens(input));

    [Fact]
    public void RenameInExpression_SkipsLiterals()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Qty"] = "Quantity" };
        Assert.Equal("Quantity > 0 AND Note <> 'Qty' AND [Quantity] < 10", TableDiff.RenameInExpression("Qty > 0 AND Note <> 'Qty' AND [Qty] < 10", map));
    }
}
