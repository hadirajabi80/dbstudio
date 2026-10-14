using System.Security.Cryptography;
using System.Text;

namespace DbStudio.Core.Services;

/// <summary>
/// Locations of the engine's files (docs/PLAN.md 2.8). Root is <c>%APPDATA%\DbStudio</c> on Windows,
/// <c>~/Library/Application Support/DbStudio</c> on macOS and <c>~/.config/DbStudio</c> (XDG) on Linux, overridable with
/// the <c>DBSTUDIO_DATA_DIR</c> environment variable (tests use a temp dir).
/// </summary>
public sealed class AppPaths
{
    public const string DataDirVariable = "DBSTUDIO_DATA_DIR";

    public AppPaths(string dataDir)
    {
        DataDir = Path.GetFullPath(dataDir);
        Directory.CreateDirectory(DataDir);
    }

    public string DataDir { get; }
    public string ConnectionsFile => Path.Combine(DataDir, "connections.json");
    public string SecretsFile => Path.Combine(DataDir, "secrets.dat");
    public string SettingsFile => Path.Combine(DataDir, "settings.json");
    public string HistoryDatabase => Path.Combine(DataDir, "history.db");
    public string LogsDir => Path.Combine(DataDir, "logs");

    /// <summary>Per-OS default (Windows %APPDATA%, macOS Application Support, Linux XDG); see <see cref="Platform.DataDirectory"/>.</summary>
    public static AppPaths FromEnvironment() => new(Platform.DataDirectory.Default());
}

/// <summary>Atomic file replacement: write a temp file next to the target, flush, then move over it.</summary>
public static class AtomicFile
{
    public static void WriteAllText(string path, string content) => WriteAllBytes(path, new UTF8Encoding(false).GetBytes(content));

    public static void WriteAllBytes(string path, byte[] content)
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(dir);
        var temp = Path.Combine(dir, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                fs.Write(content);
                fs.Flush(flushToDisk: true);
            }
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temp))
            {
                try { File.Delete(temp); } catch (IOException) { }
            }
        }
    }
}

/// <summary>Sortable unique ids with a type prefix (ULID body): "c_01J9…", "s_…", "x_…", "e_…".</summary>
public static class Ids
{
    private const string Crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

    public static string New(string prefix)
    {
        Span<byte> random = stackalloc byte[10];
        RandomNumberGenerator.Fill(random);
        var time = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Span<char> chars = stackalloc char[26];
        // 48-bit timestamp → 10 chars
        for (var i = 9; i >= 0; i--)
        {
            chars[i] = Crockford[(int)(time & 31)];
            time >>= 5;
        }
        // 80 bits of randomness → 16 chars
        var bits = 0;
        var acc = 0;
        var pos = 10;
        foreach (var b in random)
        {
            acc = (acc << 8) | b;
            bits += 8;
            while (bits >= 5)
            {
                bits -= 5;
                chars[pos++] = Crockford[(acc >> bits) & 31];
            }
        }
        return prefix + "_" + new string(chars);
    }
}
