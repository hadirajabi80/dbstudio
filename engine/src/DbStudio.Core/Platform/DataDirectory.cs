namespace DbStudio.Core.Platform;

/// <summary>
/// Default location of the engine's data (connections, secrets, settings, history, logs). It must match what the
/// Electron shell uses (<c>app.getPath('appData')/Rowlit</c>, see desktop/src/main/data-dir.ts):
/// <list type="bullet">
/// <item>Windows: <c>%APPDATA%\Rowlit</c></item>
/// <item>macOS: <c>~/Library/Application Support/Rowlit</c></item>
/// <item>Linux and others: <c>$XDG_CONFIG_HOME/Rowlit</c>, else <c>~/.config/Rowlit</c></item>
/// </list>
/// <c>DBSTUDIO_DATA_DIR</c> overrides all of them (tests, portable installs); the desktop app always sets it, so this
/// default only matters for an engine started on its own.
/// <para>
/// The product was called DbStudio up to 1.1.0 and kept its data in a <c>DbStudio</c> folder. The desktop app moves
/// that folder to <c>Rowlit</c> on first start; until then (or for an engine started on its own) an existing
/// <c>DbStudio</c> folder is used when there is no <c>Rowlit</c> folder yet, so saved connections are never "lost".
/// </para>
/// </summary>
public static class DataDirectory
{
    public const string OverrideVariable = "DBSTUDIO_DATA_DIR";
    public const string AppFolderName = "Rowlit";
    /// <summary>The folder name used by DbStudio &lt;= 1.1.0.</summary>
    public const string LegacyFolderName = "DbStudio";

    /// <summary>Resolves the data directory for the current process.</summary>
    public static string Default() => Resolve(
        HostPlatform.Current,
        Environment.GetEnvironmentVariable,
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        OperatingSystem.IsWindows() ? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData) : null,
        Directory.Exists);

    /// <summary>
    /// Pure resolution (unit tested for every OS from any OS).
    /// </summary>
    /// <param name="os">Target OS.</param>
    /// <param name="getEnv">Environment lookup.</param>
    /// <param name="userHome">The user's home directory (<c>~</c>).</param>
    /// <param name="windowsAppData">Roaming AppData as reported by the OS (Windows only; falls back to %APPDATA%).</param>
    /// <param name="directoryExists">
    /// When given, a legacy <c>DbStudio</c> folder is returned if it exists and the <c>Rowlit</c> folder does not.
    /// </param>
    public static string Resolve(HostOs os, Func<string, string?> getEnv, string userHome, string? windowsAppData = null,
        Func<string, bool>? directoryExists = null)
    {
        ArgumentNullException.ThrowIfNull(getEnv);
        var overrideDir = getEnv(OverrideVariable);
        if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir.Trim();

        var parent = ParentFolder(os, getEnv, userHome, windowsAppData);
        var current = Combine(os, parent, AppFolderName);
        if (directoryExists is not null && !directoryExists(current))
        {
            var legacy = Combine(os, parent, LegacyFolderName);
            if (directoryExists(legacy)) return legacy;
        }
        return current;
    }

    /// <summary>The per-OS folder that holds the app folder (Roaming AppData, Application Support, XDG config).</summary>
    private static string ParentFolder(HostOs os, Func<string, string?> getEnv, string userHome, string? windowsAppData)
    {
        switch (os)
        {
            case HostOs.Windows:
                return NonEmpty(windowsAppData) ?? NonEmpty(getEnv("APPDATA"))
                    ?? Combine(os, RequireHome(userHome), "AppData", "Roaming");
            case HostOs.MacOS:
                return Combine(os, RequireHome(userHome), "Library", "Application Support");
            default:
            {
                // XDG Base Directory spec: ignore relative values.
                var xdg = NonEmpty(getEnv("XDG_CONFIG_HOME"));
                if (xdg is not null && xdg.StartsWith('/')) return xdg;
                return Combine(os, RequireHome(userHome), ".config");
            }
        }
    }

    private static string? NonEmpty(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

    private static string RequireHome(string userHome) =>
        NonEmpty(userHome) ?? throw new InvalidOperationException(
            $"Cannot determine the user's home directory; set {OverrideVariable} to choose a data directory.");

    /// <summary>Joins with the target OS's separator so results are stable when resolving for another OS in tests.</summary>
    private static string Combine(HostOs os, string first, params string[] rest)
    {
        var sep = os == HostOs.Windows ? '\\' : '/';
        var result = first.TrimEnd('/', '\\');
        foreach (var part in rest) result = result + sep + part;
        return result;
    }
}
