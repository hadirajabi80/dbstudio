namespace DbStudio.Core.Platform;

/// <summary>
/// Default location of the engine's data (connections, secrets, settings, history, logs). It must match what the
/// Electron shell uses (<c>app.getPath('appData')/DbStudio</c>, see desktop/src/main/paths.ts):
/// <list type="bullet">
/// <item>Windows: <c>%APPDATA%\DbStudio</c></item>
/// <item>macOS: <c>~/Library/Application Support/DbStudio</c></item>
/// <item>Linux and others: <c>$XDG_CONFIG_HOME/DbStudio</c>, else <c>~/.config/DbStudio</c></item>
/// </list>
/// <c>DBSTUDIO_DATA_DIR</c> overrides all of them (tests, portable installs).
/// </summary>
public static class DataDirectory
{
    public const string OverrideVariable = "DBSTUDIO_DATA_DIR";
    public const string AppFolderName = "DbStudio";

    /// <summary>Resolves the data directory for the current process.</summary>
    public static string Default() => Resolve(
        HostPlatform.Current,
        Environment.GetEnvironmentVariable,
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        OperatingSystem.IsWindows() ? Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData) : null);

    /// <summary>
    /// Pure resolution (unit tested for every OS from any OS).
    /// </summary>
    /// <param name="os">Target OS.</param>
    /// <param name="getEnv">Environment lookup.</param>
    /// <param name="userHome">The user's home directory (<c>~</c>).</param>
    /// <param name="windowsAppData">Roaming AppData as reported by the OS (Windows only; falls back to %APPDATA%).</param>
    public static string Resolve(HostOs os, Func<string, string?> getEnv, string userHome, string? windowsAppData = null)
    {
        ArgumentNullException.ThrowIfNull(getEnv);
        var overrideDir = getEnv(OverrideVariable);
        if (!string.IsNullOrWhiteSpace(overrideDir)) return overrideDir.Trim();

        switch (os)
        {
            case HostOs.Windows:
            {
                var appData = NonEmpty(windowsAppData) ?? NonEmpty(getEnv("APPDATA"))
                    ?? Combine(os, RequireHome(userHome), "AppData", "Roaming");
                return Combine(os, appData, AppFolderName);
            }
            case HostOs.MacOS:
                return Combine(os, RequireHome(userHome), "Library", "Application Support", AppFolderName);
            default:
            {
                // XDG Base Directory spec: ignore relative values.
                var xdg = NonEmpty(getEnv("XDG_CONFIG_HOME"));
                if (xdg is not null && xdg.StartsWith('/')) return Combine(os, xdg, AppFolderName);
                return Combine(os, RequireHome(userHome), ".config", AppFolderName);
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
