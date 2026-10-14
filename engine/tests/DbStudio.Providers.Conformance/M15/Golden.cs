using System.Runtime.CompilerServices;
using System.Text;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.Conformance.M15;

/// <summary>
/// Golden-file assertions for generated DDL. Files live next to the calling test under <c>M15/golden/</c> (resolved
/// from the source path, so nothing is copied to the output). Set <c>DBSTUDIO_UPDATE_GOLDEN=1</c> to (re)write them.
/// </summary>
public static class Golden
{
    public static bool Updating => Environment.GetEnvironmentVariable("DBSTUDIO_UPDATE_GOLDEN") == "1";

    public static void Match(string name, string actual, [CallerFilePath] string callerFile = "")
    {
        var dir = Path.Combine(Path.GetDirectoryName(callerFile)!, "golden");
        var file = Path.Combine(dir, name);
        var normalized = actual.Replace("\r\n", "\n");
        if (Updating)
        {
            Directory.CreateDirectory(dir);
            File.WriteAllText(file, normalized, new UTF8Encoding(false));
            return;
        }
        Assert.True(File.Exists(file), $"Golden file {file} is missing; run the tests with DBSTUDIO_UPDATE_GOLDEN=1 and review it.");
        var expected = File.ReadAllText(file).Replace("\r\n", "\n");
        Assert.Equal(expected, normalized);
    }

    /// <summary>
    /// Keeps a UI test fixture (<c>ui/src/mocks/fixtures/m15/&lt;relativePath&gt;</c>) in sync with what the engine produces:
    /// written in update mode, compared otherwise. The payload is serialized with the wire JSON options.
    /// </summary>
    public static void MatchUiFixture(string relativePath, object payload, [CallerFilePath] string callerFile = "")
    {
        var dir = new DirectoryInfo(Path.GetDirectoryName(callerFile)!);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "ui", "src"))) dir = dir.Parent;
        Assert.True(dir is not null, "Repository root (with ui/src) not found above " + callerFile);
        var file = Path.Combine(dir!.FullName, "ui", "src", "mocks", "fixtures", "m15", relativePath.Replace('/', Path.DirectorySeparatorChar));
        var json = System.Text.Json.JsonSerializer.Serialize(payload, payload.GetType(), Core.Services.CoreJson.Indented).Replace("\r\n", "\n") + "\n";
        if (Updating)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, json, new UTF8Encoding(false));
            return;
        }
        Assert.True(File.Exists(file), $"UI fixture {file} is missing; run the tests with DBSTUDIO_UPDATE_GOLDEN=1.");
        Assert.Equal(File.ReadAllText(file).Replace("\r\n", "\n"), json);
    }

    /// <summary>Stable text form of a script: header, statements terminated with ";" (or "GO"/"/" per dialect) and warnings.</summary>
    public static string Render(TableScript script, string terminator = ";") =>
        Render(script.Statements, script.RebuildRequired, script.Transactional, script.Warnings, terminator);

    public static string Render(DdlScript script, string terminator = ";") =>
        Render(script.Statements, script.RebuildRequired, script.Transactional, script.Warnings, terminator);

    private static string Render(IReadOnlyList<DdlStatement> statements, bool rebuild, bool transactional, IReadOnlyList<string> warnings, string terminator)
    {
        var sb = new StringBuilder();
        sb.Append("-- rebuildRequired: ").Append(rebuild ? "true" : "false").Append(", transactional: ").Append(transactional ? "true" : "false").Append('\n');
        foreach (var w in warnings) sb.Append("-- warning: ").Append(w).Append('\n');
        foreach (var s in statements)
        {
            sb.Append('\n');
            sb.Append("-- [").Append(s.Kind).Append(']');
            if (s.Warning is not null) sb.Append(" ").Append(s.Warning);
            sb.Append('\n').Append(s.Sql);
            sb.Append(terminator == "GO" || terminator == "/" ? "\n" + terminator : terminator).Append('\n');
        }
        return sb.ToString();
    }
}
