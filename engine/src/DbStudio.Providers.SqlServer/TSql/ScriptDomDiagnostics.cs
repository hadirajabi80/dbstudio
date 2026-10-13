using System.Reflection;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Providers;
using Microsoft.SqlServer.TransactSql.ScriptDom;

namespace DbStudio.Providers.SqlServer.TSql;

/// <summary>
/// T-SQL syntax diagnostics with ScriptDom. Uses the highest TSqlNNNParser in the referenced ScriptDom assembly,
/// splits the document on GO lines and maps every parse error to 1-based absolute document positions.
/// </summary>
public sealed partial class ScriptDomDiagnostics : ISqlDiagnostics
{
    private static readonly Lazy<(Type Type, int Version)> s_parserType = new(FindHighestParser);

    public string EngineName => "scriptdom";

    /// <summary>The parser class in use, e.g. "TSql170Parser".</summary>
    public static string ParserName => s_parserType.Value.Type.Name;

    /// <summary>The parser version number, e.g. 170.</summary>
    public static int ParserVersion => s_parserType.Value.Version;

    public Task<IReadOnlyList<SqlDiagnostic>> AnalyzeAsync(string sql, ConnectionProfile? profile, string? password, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        return Task.FromResult(Analyze(sql, ct));
    }

    /// <summary>Synchronous core; parsing is CPU bound and fast.</summary>
    public static IReadOnlyList<SqlDiagnostic> Analyze(string sql, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(sql);
        var result = new List<SqlDiagnostic>();
        foreach (var batch in BatchSplitter.Split(sql))
        {
            ct.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(batch.Text)) continue;
            var parser = CreateParser();
            using var reader = new StringReader(batch.Text);
            parser.Parse(reader, out IList<ParseError> errors);
            foreach (var e in errors)
            {
                // ScriptDom lines/columns are 1-based relative to the batch; batches always start at column 1.
                int line = batch.StartLine + Math.Max(1, e.Line) - 1;
                int col = Math.Max(1, e.Column);
                var (endLine, endCol) = TokenEnd(batch.Text, e.Offset, line, col);
                result.Add(new SqlDiagnostic(line, col, endLine, endCol, "error", "SQL" + e.Number, e.Message));
            }
        }
        return result;
    }

    /// <summary>Creates a parser instance (quoted identifiers on) of the highest version available.</summary>
    public static TSqlParser CreateParser()
    {
        var t = s_parserType.Value.Type;
        return (TSqlParser)Activator.CreateInstance(t, [true])!; // initialQuotedIdentifiers: true
    }

    private static (Type, int) FindHighestParser()
    {
        var asm = typeof(TSqlParser).Assembly;
        Type best = typeof(TSql160Parser);
        int bestVersion = 160;
        foreach (var t in SafeTypes(asm))
        {
            if (t.IsAbstract || !typeof(TSqlParser).IsAssignableFrom(t)) continue;
            var m = ParserNameRegex().Match(t.Name);
            if (!m.Success || !int.TryParse(m.Groups[1].Value, out var v)) continue;
            if (v <= bestVersion) continue;
            if (t.GetConstructor(BindingFlags.Public | BindingFlags.Instance, [typeof(bool)]) is null) continue;
            best = t;
            bestVersion = v;
        }
        return (best, bestVersion);
    }

    private static IEnumerable<Type> SafeTypes(Assembly asm)
    {
        try { return asm.GetExportedTypes(); }
        catch (ReflectionTypeLoadException ex) { return ex.Types.Where(t => t is not null)!; }
    }

    [GeneratedRegex(@"^TSql(\d+)Parser$")]
    private static partial Regex ParserNameRegex();

    /// <summary>End of the token starting at <paramref name="offset"/> (exclusive end column, same line).</summary>
    private static (int Line, int Col) TokenEnd(string text, int offset, int line, int col)
    {
        if (offset < 0 || offset >= text.Length) return (line, col + 1);
        int i = offset;
        char c = text[i];
        if (char.IsLetterOrDigit(c) || c is '_' or '@' or '#' or '$')
        {
            while (i < text.Length && (char.IsLetterOrDigit(text[i]) || text[i] is '_' or '@' or '#' or '$')) i++;
        }
        else if (c is '[' or '"' or '\'')
        {
            char close = c == '[' ? ']' : c;
            i++;
            while (i < text.Length && text[i] != close && text[i] != '\n') i++;
            if (i < text.Length && text[i] == close) i++;
        }
        else if (!char.IsWhiteSpace(c))
        {
            i++;
        }
        else
        {
            return (line, col + 1);
        }
        return (line, col + Math.Max(1, i - offset));
    }
}
