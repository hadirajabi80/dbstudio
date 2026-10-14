using System.Runtime.CompilerServices;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace DbStudio.Core.Tests.FormatterParity;

/// <summary>
/// docs/PLAN-M1.5.md 1.2 guarantee 6: formatting T-SQL never changes its meaning. For every
/// <c>ui/src/format/__tests__/fixtures/tsql/*.sql</c> / <c>*.expected.sql</c> pair (the renderer formatter's own
/// fixtures) the input and the formatted output must produce the same ScriptDom token stream (ignoring whitespace,
/// comments and keyword case) and the same parse tree (compared through the script generator).
/// Inputs that do not parse are only checked for token equality (the formatter emits them verbatim).
/// </summary>
public sealed class FormatterParityTests
{
    private static string FixtureDir([CallerFilePath] string here = "")
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(here)!);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "ui", "src"))) dir = dir.Parent;
        return dir is null ? "" : Path.Combine(dir.FullName, "ui", "src", "format", "__tests__", "fixtures", "tsql");
    }

    public static TheoryData<string> Fixtures()
    {
        var data = new TheoryData<string>();
        var dir = FixtureDir();
        if (Directory.Exists(dir))
        {
            foreach (var expected in Directory.EnumerateFiles(dir, "*.expected.sql").Order(StringComparer.Ordinal))
            {
                var input = expected[..^".expected.sql".Length] + ".sql";
                if (File.Exists(input)) data.Add(Path.GetFileName(input));
            }
        }
        if (data.Count == 0) data.Add("(none)");
        return data;
    }

    private static (TSqlFragment? Tree, IList<ParseError> Errors) Parse(string sql)
    {
        var parser = new TSql160Parser(initialQuotedIdentifiers: true);
        var tree = parser.Parse(new StringReader(sql), out var errors);
        return (tree, errors);
    }

    private static List<(TSqlTokenType Type, string Text)> Tokens(string sql)
    {
        var parser = new TSql160Parser(initialQuotedIdentifiers: true);
        var stream = parser.GetTokenStream(new StringReader(sql), out _);
        return stream
            .Where(t => t.TokenType is not (TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment or TSqlTokenType.EndOfFile))
            .Select(t => (t.TokenType, IsCaseFree(t.TokenType) ? t.Text : t.Text.ToUpperInvariant()))
            .ToList();
    }

    /// <summary>
    /// Tokens whose text the formatter must keep byte for byte. Plain identifiers compare case-insensitively: ScriptDom
    /// lexes contextual keywords (APPLY, USING, LOCAL, ...) as identifiers, and the formatter cases those as keywords.
    /// </summary>
    private static bool IsCaseFree(TSqlTokenType t) => t is TSqlTokenType.QuotedIdentifier
        or TSqlTokenType.AsciiStringLiteral or TSqlTokenType.UnicodeStringLiteral or TSqlTokenType.AsciiStringOrQuotedIdentifier
        or TSqlTokenType.Variable or TSqlTokenType.Integer or TSqlTokenType.Numeric or TSqlTokenType.Real or TSqlTokenType.HexLiteral or TSqlTokenType.Money;

    private static string Generate(TSqlFragment tree)
    {
        var generator = new Sql160ScriptGenerator(new SqlScriptGeneratorOptions { KeywordCasing = KeywordCasing.Uppercase });
        generator.GenerateScript(tree, out var script);
        return script;
    }

    [Theory]
    [MemberData(nameof(Fixtures))]
    public void FormattedTSql_HasTheSameTokensAndParseTree(string fixture)
    {
        if (fixture == "(none)") return; // the formatter fixtures are not present in this checkout
        var dir = FixtureDir();
        var input = File.ReadAllText(Path.Combine(dir, fixture));
        var output = File.ReadAllText(Path.Combine(dir, fixture[..^".sql".Length] + ".expected.sql"));

        Assert.Equal(Tokens(input), Tokens(output));

        var (inTree, inErrors) = Parse(input);
        if (inErrors.Count > 0 || inTree is null) return;
        var (outTree, outErrors) = Parse(output);
        Assert.True(outErrors.Count == 0, $"{fixture}: the formatted text no longer parses: {string.Join("; ", outErrors.Select(e => $"{e.Line}:{e.Column} {e.Message}"))}");
        // Function names are identifiers to ScriptDom (kept as typed); literal case is already checked by the token stream.
        Assert.Equal(Generate(inTree), Generate(outTree!), ignoreCase: true);
    }
}
