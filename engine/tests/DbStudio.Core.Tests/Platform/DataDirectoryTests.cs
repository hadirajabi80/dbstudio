using DbStudio.Core.Platform;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests.Platform;

public class DataDirectoryTests
{
    private static Func<string, string?> Env(params (string Key, string Value)[] vars)
    {
        var map = vars.ToDictionary(v => v.Key, v => v.Value);
        return k => map.GetValueOrDefault(k);
    }

    [Fact]
    public void Windows_UsesRoamingAppData()
    {
        Assert.Equal(@"C:\Users\ann\AppData\Roaming\Rowlit",
            DataDirectory.Resolve(HostOs.Windows, Env(), @"C:\Users\ann", @"C:\Users\ann\AppData\Roaming"));
        // Folder API unavailable: %APPDATA%, then the profile's AppData\Roaming.
        Assert.Equal(@"D:\Roam\Rowlit", DataDirectory.Resolve(HostOs.Windows, Env(("APPDATA", @"D:\Roam\")), @"C:\Users\ann"));
        Assert.Equal(@"C:\Users\ann\AppData\Roaming\Rowlit", DataDirectory.Resolve(HostOs.Windows, Env(), @"C:\Users\ann"));
    }

    [Fact]
    public void LegacyDbStudioFolder_IsUsedOnlyUntilARowlitFolderExists()
    {
        const string appData = @"C:\Users\ann\AppData\Roaming";
        string Resolve(params string[] existing) =>
            DataDirectory.Resolve(HostOs.Windows, Env(), @"C:\Users\ann", appData, d => existing.Contains(d));

        // DbStudio <= 1.1.0 data and no Rowlit folder yet (the desktop app moves it on first start): keep using it.
        Assert.Equal(appData + @"\DbStudio", Resolve(appData + @"\DbStudio"));
        // Once the Rowlit folder exists it always wins.
        Assert.Equal(appData + @"\Rowlit", Resolve(appData + @"\DbStudio", appData + @"\Rowlit"));
        Assert.Equal(appData + @"\Rowlit", Resolve(appData + @"\Rowlit"));
        Assert.Equal(appData + @"\Rowlit", Resolve());
        // macOS / Linux use the same rule.
        Assert.Equal("/Users/ann/Library/Application Support/DbStudio",
            DataDirectory.Resolve(HostOs.MacOS, Env(), "/Users/ann", null, d => d == "/Users/ann/Library/Application Support/DbStudio"));
        Assert.Equal("/home/ann/.config/DbStudio",
            DataDirectory.Resolve(HostOs.Linux, Env(), "/home/ann", null, d => d == "/home/ann/.config/DbStudio"));
        // The override is never second-guessed.
        Assert.Equal("/data", DataDirectory.Resolve(HostOs.Linux, Env((DataDirectory.OverrideVariable, "/data")), "/home/ann", null, _ => false));
    }

    [Fact]
    public void MacOS_UsesApplicationSupport_AndIgnoresXdg()
    {
        Assert.Equal("/Users/ann/Library/Application Support/Rowlit",
            DataDirectory.Resolve(HostOs.MacOS, Env(("XDG_CONFIG_HOME", "/tmp/xdg")), "/Users/ann"));
    }

    [Theory]
    [InlineData(HostOs.Linux)]
    [InlineData(HostOs.Other)]
    public void Linux_UsesXdgConfigHome_ThenDotConfig(HostOs os)
    {
        Assert.Equal("/home/ann/.xdg/Rowlit", DataDirectory.Resolve(os, Env(("XDG_CONFIG_HOME", "/home/ann/.xdg/")), "/home/ann"));
        Assert.Equal("/home/ann/.config/Rowlit", DataDirectory.Resolve(os, Env(), "/home/ann"));
        // The XDG spec says relative values are invalid and must be ignored.
        Assert.Equal("/home/ann/.config/Rowlit", DataDirectory.Resolve(os, Env(("XDG_CONFIG_HOME", "relative/dir")), "/home/ann"));
    }

    [Theory]
    [InlineData(HostOs.Windows)]
    [InlineData(HostOs.MacOS)]
    [InlineData(HostOs.Linux)]
    public void Override_WinsOnEveryOs(HostOs os)
    {
        Assert.Equal("/data/dbs", DataDirectory.Resolve(os, Env((DataDirectory.OverrideVariable, " /data/dbs ")), "/home/ann", @"C:\x"));
        Assert.Equal(AppPaths.DataDirVariable, DataDirectory.OverrideVariable);
    }

    [Fact]
    public void MissingHome_IsAnActionableError()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => DataDirectory.Resolve(HostOs.MacOS, Env(), ""));
        Assert.Contains(DataDirectory.OverrideVariable, ex.Message);
    }

    [Fact]
    public void Default_MatchesTheCurrentOs()
    {
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(DataDirectory.OverrideVariable))) return;
        var dir = DataDirectory.Default();
        // "Rowlit", or "DbStudio" on a machine that still has DbStudio data and no Rowlit folder yet
        var folder = Path.GetFileName(dir);
        Assert.Contains(folder, new[] { DataDirectory.AppFolderName, DataDirectory.LegacyFolderName });
        if (OperatingSystem.IsWindows())
            Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), folder), dir);
        else if (OperatingSystem.IsMacOS())
            Assert.Contains("/Library/Application Support/", dir);
    }
}
