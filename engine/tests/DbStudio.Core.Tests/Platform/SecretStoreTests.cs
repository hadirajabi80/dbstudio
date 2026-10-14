using System.Text;
using System.Text.Json;
using DbStudio.Core.Platform;
using DbStudio.Core.Secrets;
using DbStudio.Core.Services;

namespace DbStudio.Core.Tests.Platform;

/// <summary>[Fact] that only runs on macOS (the real login keychain).</summary>
public sealed class MacOSFactAttribute : FactAttribute
{
    public MacOSFactAttribute()
    {
        if (!OperatingSystem.IsMacOS()) Skip = "macOS only (uses the login keychain).";
        else if (Environment.GetEnvironmentVariable("DBSTUDIO_SKIP_KEYCHAIN_TESTS") == "1") Skip = "DBSTUDIO_SKIP_KEYCHAIN_TESTS=1";
    }
}

internal static class TempDirs
{
    public static string New()
    {
        var dir = Path.Combine(Path.GetTempPath(), "dbstudio-core-tests", "platform-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        return dir;
    }
}

public class AppPathsTests
{
    [Fact]
    public void FilesLiveUnderTheDataDir()
    {
        var dir = TempDirs.New();
        var paths = new AppPaths(Path.Combine(dir, "nested", "..", "data"));
        Assert.Equal(Path.GetFullPath(Path.Combine(dir, "data")), paths.DataDir);
        Assert.True(Directory.Exists(paths.DataDir));
        foreach (var f in new[] { paths.ConnectionsFile, paths.SecretsFile, paths.SettingsFile, paths.HistoryDatabase, paths.LogsDir })
            Assert.Equal(paths.DataDir, Path.GetDirectoryName(f));
    }
}

public class SecretStoreFactoryTests
{
    [Fact]
    public void ChoosesTheOsStore()
    {
        Assert.Equal(SecretStoreKind.Dpapi, SecretStoreFactory.Choose(HostOs.Windows));
        Assert.Equal(SecretStoreKind.Keychain, SecretStoreFactory.Choose(HostOs.MacOS));
        Assert.Equal(SecretStoreKind.File, SecretStoreFactory.Choose(HostOs.Linux));
        Assert.Equal(SecretStoreKind.File, SecretStoreFactory.Choose(HostOs.Other));
    }

    [Fact]
    public void OverrideIsCaseInsensitive_AndValidated()
    {
        Assert.Equal(SecretStoreKind.Memory, SecretStoreFactory.Choose(HostOs.Windows, " Memory "));
        Assert.Equal(SecretStoreKind.File, SecretStoreFactory.Choose(HostOs.MacOS, "file"));
        Assert.Equal(SecretStoreKind.Keychain, SecretStoreFactory.Choose(HostOs.Linux, "KEYCHAIN"));
        Assert.Equal(SecretStoreKind.Dpapi, SecretStoreFactory.Choose(HostOs.Linux, "dpapi"));
        Assert.Equal(SecretStoreKind.Keychain, SecretStoreFactory.Choose(HostOs.MacOS, "  "));
        Assert.Throws<ArgumentException>(() => SecretStoreFactory.Choose(HostOs.Windows, "plaintext"));
    }

    [Fact]
    public void CreatesTheRightTypeForThisOs()
    {
        var paths = new AppPaths(TempDirs.New());
        var store = SecretStoreFactory.Create(paths, SecretStoreFactory.Choose(HostPlatform.Current));
        if (OperatingSystem.IsWindows()) Assert.IsType<DpapiSecretStore>(store);
        else if (OperatingSystem.IsMacOS()) Assert.IsType<KeychainSecretStore>(store);
        else Assert.IsType<FileSecretStore>(store);

        Assert.IsType<FileSecretStore>(SecretStoreFactory.Create(paths, SecretStoreKind.File));
        Assert.IsType<InMemorySecretStore>(SecretStoreFactory.Create(paths, SecretStoreKind.Memory));
    }

    [Fact]
    public void RefusesAnOsStoreOnTheWrongOs()
    {
        var paths = new AppPaths(TempDirs.New());
        if (!OperatingSystem.IsWindows())
            Assert.Throws<PlatformNotSupportedException>(() => SecretStoreFactory.Create(paths, SecretStoreKind.Dpapi));
        if (!OperatingSystem.IsMacOS())
            Assert.Throws<PlatformNotSupportedException>(() => SecretStoreFactory.Create(paths, SecretStoreKind.Keychain));
    }
}

public class FileSecretStoreTests
{
    [Fact]
    public void RoundTrips_EncryptsAtRest_AndBindsToProfileId()
    {
        var paths = new AppPaths(TempDirs.New());
        var store = new FileSecretStore(paths);
        store.Set("c_1", "pa$$wörd ✓", persist: true);
        store.Set("c_2", "memory-only", persist: false);

        var text = File.ReadAllText(store.SecretsFile);
        Assert.DoesNotContain("pa$$", text);
        Assert.DoesNotContain("c_2", text);
        Assert.Equal(32, File.ReadAllBytes(store.KeyFile).Length);
        if (!OperatingSystem.IsWindows())
        {
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(store.KeyFile));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(store.SecretsFile));
        }

        var fresh = new FileSecretStore(paths);
        Assert.Equal("pa$$wörd ✓", fresh.Get("c_1"));
        Assert.True(fresh.Has("c_1"));
        Assert.Null(fresh.Get("c_2"));
        Assert.Equal("memory-only", store.Get("c_2"));

        // A blob copied to another profile id fails authentication (AAD includes the id).
        var map = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(store.SecretsFile))!;
        map["c_3"] = map["c_1"];
        File.WriteAllText(store.SecretsFile, JsonSerializer.Serialize(map));
        Assert.Null(new FileSecretStore(paths).Get("c_3"));

        // Switching an existing secret to memory-only removes the persisted copy.
        fresh.Set("c_1", "now-in-memory", persist: false);
        Assert.False(new FileSecretStore(paths).Has("c_1"));
        Assert.Equal("now-in-memory", fresh.Get("c_1"));
        fresh.Remove("c_1");
        Assert.False(fresh.Has("c_1"));
    }

    [Fact]
    public void LostOrDifferentKey_MeansNoPassword()
    {
        var paths = new AppPaths(TempDirs.New());
        var store = new FileSecretStore(paths);
        store.Set("c_1", "secret", persist: true);
        File.Delete(store.KeyFile);
        Assert.Null(new FileSecretStore(paths).Get("c_1"));
        File.WriteAllBytes(store.KeyFile, new byte[32]);
        Assert.Null(new FileSecretStore(paths).Get("c_1"));
    }
}

/// <summary>Simulates /usr/bin/security over an in-memory keychain and records every invocation.</summary>
internal sealed class FakeSecurityCli : ISecurityCli
{
    public readonly Dictionary<(string Service, string Account), string> Items = new();
    public readonly List<(string[] Args, string? Stdin)> Calls = new();
    /// <summary>When set, writes are silently dropped (like a failing command in `security -i`).</summary>
    public bool DropWrites { get; set; }

    public SecurityCliResult Run(IReadOnlyList<string> arguments, string? standardInput)
    {
        Calls.Add((arguments.ToArray(), standardInput));
        if (arguments is ["-i"])
        {
            foreach (var line in (standardInput ?? "").Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var argv = line.Split(' ');
                Assert.Equal("add-generic-password", argv[0]);
                Assert.Contains("-U", argv);
                if (DropWrites) return new SecurityCliResult(0, "", "security: SecKeychainItemCreateFromContent: User interaction is not allowed.");
                var hex = Opt(argv, "-X");
                Items[(Opt(argv, "-s"), Opt(argv, "-a"))] = Encoding.ASCII.GetString(Convert.FromHexString(hex));
            }
            return new SecurityCliResult(0, "", "");
        }
        var key = (Opt(arguments, "-s"), Opt(arguments, "-a"));
        switch (arguments[0])
        {
            case "find-generic-password":
                if (!Items.TryGetValue(key, out var data)) return new SecurityCliResult(44, "", "security: The specified item could not be found in the keychain.");
                return arguments.Contains("-w")
                    ? new SecurityCliResult(0, data + "\n", "")
                    : new SecurityCliResult(0, $"keychain: \"login.keychain-db\"\nattributes:\n    \"acct\"<blob>=\"{key.Item2}\"\n", "");
            case "delete-generic-password":
                return Items.Remove(key) ? new SecurityCliResult(0, "", "") : new SecurityCliResult(44, "", "not found");
            default:
                throw new InvalidOperationException("unexpected security command " + arguments[0]);
        }
    }

    private static string Opt(IReadOnlyList<string> argv, string name)
    {
        for (var i = 0; i < argv.Count - 1; i++) if (argv[i] == name) return argv[i + 1];
        throw new InvalidOperationException($"missing {name}");
    }
}

public class KeychainSecretStoreTests
{
    [Fact]
    public void NeverPutsTheSecretOnTheCommandLine()
    {
        var cli = new FakeSecurityCli();
        var store = new KeychainSecretStore(cli);
        const string secret = "s3cr\"et -w; rm -rf ~ \n ünï";
        store.Set("c_01J9ABC", secret, persist: true);

        Assert.Equal(secret, store.Get("c_01J9ABC"));
        Assert.True(store.Has("c_01J9ABC"));
        var b64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(secret));
        foreach (var (args, stdin) in cli.Calls)
        {
            Assert.DoesNotContain(args, a => a.Contains("s3cr") || a.Contains(b64));
            // stdin carries the add command with hex data only: no raw secret, no quoting.
            if (stdin is not null) Assert.DoesNotContain("s3cr", stdin);
        }
        var add = Assert.Single(cli.Calls, c => c.Args is ["-i"]);
        Assert.Matches("^add-generic-password -U -s DbStudio -a c_01J9ABC -X [0-9A-F]+\n$", add.Stdin);
        Assert.Equal("b64:" + b64, cli.Items[("DbStudio", "c_01J9ABC")]);
    }

    [Fact]
    public void MemoryOnly_RemovesTheKeychainItem_AndRemoveIsIdempotent()
    {
        var cli = new FakeSecurityCli();
        var store = new KeychainSecretStore(cli);
        store.Set("c_1", "persisted", persist: true);
        store.Set("c_1", "in-memory", persist: false);
        Assert.Empty(cli.Items);
        Assert.Equal("in-memory", store.Get("c_1"));
        store.Remove("c_1");
        store.Remove("c_1");
        Assert.False(store.Has("c_1"));
        Assert.Null(store.Get("c_1"));
    }

    [Fact]
    public void HasIsCached_AfterTheFirstLookup()
    {
        var cli = new FakeSecurityCli();
        var store = new KeychainSecretStore(cli);
        Assert.False(store.Has("c_9"));
        Assert.False(store.Has("c_9"));
        Assert.Single(cli.Calls);
    }

    [Fact]
    public void ReadsItemsWrittenByOtherTools_AsIs()
    {
        var cli = new FakeSecurityCli();
        cli.Items[("DbStudio", "c_1")] = "plain-password";
        Assert.Equal("plain-password", new KeychainSecretStore(cli).Get("c_1"));
    }

    [Fact]
    public void FailedWrite_IsReported()
    {
        var cli = new FakeSecurityCli { DropWrites = true };
        var ex = Assert.Throws<InvalidOperationException>(() => new KeychainSecretStore(cli).Set("c_1", "x", persist: true));
        Assert.Contains("User interaction is not allowed", ex.Message);
    }

    [Theory]
    [InlineData("c 1")]
    [InlineData("c_1\nadd-generic-password")]
    [InlineData("c_1;x")]
    [InlineData("\"c\"")]
    public void RejectsProfileIdsThatWouldNeedQuoting(string id)
    {
        var store = new KeychainSecretStore(new FakeSecurityCli());
        Assert.Throws<ArgumentException>(() => store.Set(id, "x", persist: true));
        Assert.Throws<ArgumentException>(() => store.Get(id));
    }

    [MacOSFact]
    public void RealKeychain_RoundTrip()
    {
        var service = "DbStudio.Tests." + Guid.NewGuid().ToString("N")[..8];
        var store = new KeychainSecretStore(new SecurityCli(timeout: TimeSpan.FromSeconds(30)), service);
        const string id = "c_test";
        try
        {
            store.Set(id, "pä$$ \"word\"", persist: true);
            var fresh = new KeychainSecretStore(new SecurityCli(), service);
            Assert.True(fresh.Has(id));
            Assert.Equal("pä$$ \"word\"", fresh.Get(id));
            fresh.Set(id, "updated", persist: true); // -U updates in place
            Assert.Equal("updated", new KeychainSecretStore(new SecurityCli(), service).Get(id));
        }
        finally
        {
            store.Remove(id);
        }
        Assert.False(new KeychainSecretStore(new SecurityCli(), service).Has(id));
    }
}
