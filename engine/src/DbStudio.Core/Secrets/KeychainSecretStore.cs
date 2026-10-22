using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

namespace DbStudio.Core.Secrets;

/// <summary>Result of one <c>/usr/bin/security</c> invocation.</summary>
public sealed record SecurityCliResult(int ExitCode, string StandardOutput, string StandardError);

/// <summary>Runs the macOS <c>security</c> tool. Abstracted so the store's command construction is testable anywhere.</summary>
public interface ISecurityCli
{
    /// <param name="arguments">argv (never contains a secret).</param>
    /// <param name="standardInput">Written to stdin and then closed; null closes stdin immediately.</param>
    SecurityCliResult Run(IReadOnlyList<string> arguments, string? standardInput);
}

/// <summary>Spawns <c>/usr/bin/security</c> with redirected stdio.</summary>
public sealed class SecurityCli : ISecurityCli
{
    public const string DefaultPath = "/usr/bin/security";
    private readonly string _path;
    private readonly TimeSpan _timeout;

    /// <param name="timeout">Generous by default: an unlock prompt for a locked keychain waits for the user.</param>
    public SecurityCli(string path = DefaultPath, TimeSpan? timeout = null)
    {
        _path = path;
        _timeout = timeout ?? TimeSpan.FromSeconds(120);
    }

    public SecurityCliResult Run(IReadOnlyList<string> arguments, string? standardInput)
    {
        var psi = new ProcessStartInfo(_path)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        foreach (var a in arguments) psi.ArgumentList.Add(a);

        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"Could not start {_path}.");
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        try
        {
            if (standardInput is not null) p.StandardInput.Write(standardInput);
        }
        catch (IOException)
        {
            // security exited early (bad arguments); its stderr explains why.
        }
        finally
        {
            try { p.StandardInput.Close(); } catch (IOException) { }
        }

        if (!p.WaitForExit(_timeout))
        {
            try { p.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            throw new TimeoutException($"{_path} did not finish within {_timeout.TotalSeconds:0} s.");
        }
        p.WaitForExit(); // flush the async readers
        return new SecurityCliResult(p.ExitCode, stdout.GetAwaiter().GetResult(), stderr.GetAwaiter().GetResult());
    }
}

/// <summary>
/// macOS Keychain-backed secret store: one generic-password item per saved connection in the user's default
/// (login) keychain, service <c>DbStudio</c>, account = profile id.
/// <para>
/// The secret never appears on a command line (where <c>ps</c> could read it): writes run <c>security -i</c> and pass
/// the <c>add-generic-password</c> command on stdin, with the data hex-encoded (<c>-X</c>) so no quoting is involved.
/// Reads use <c>find-generic-password -w</c>, which prints the data on stdout. The stored data is
/// <c>b64:</c> + base64(UTF-8 secret) so it is always printable ASCII (<c>-w</c> would otherwise hex-dump
/// non-ASCII passwords) and round-trips exactly.
/// </para>
/// <para>
/// Because the item is created by <c>/usr/bin/security</c>, its access list trusts that tool, so the engine can read it
/// back without a Keychain prompt even after an update changes the (ad-hoc) engine signature. The item is protected by
/// the login keychain password (encrypted at rest, locked with the keychain); like DPAPI it does not protect against
/// other software running as the same user.
/// </para>
/// </summary>
public sealed partial class KeychainSecretStore : PersistentSecretStoreBase
{
    /// <summary>
    /// Keychain service of every saved password. Keeps the DbStudio-era name after the product was renamed to Rowlit:
    /// passwords saved by DbStudio &lt;= 1.1.0 are found under it, so nothing has to be migrated.
    /// </summary>
    public const string DefaultService = "DbStudio";
    private const string Prefix = "b64:";
    /// <summary>errSecItemNotFound as reported by the security tool.</summary>
    public const int ItemNotFoundExitCode = 44;

    private readonly ISecurityCli _cli;
    private readonly string _service;
    private readonly ConcurrentDictionary<string, bool> _hasCache = new(StringComparer.Ordinal);

    public KeychainSecretStore(ISecurityCli? cli = null, string service = DefaultService)
    {
        if (!SafeToken().IsMatch(service)) throw new ArgumentException("Invalid keychain service name.", nameof(service));
        _cli = cli ?? new SecurityCli();
        _service = service;
    }

    public string Service => _service;

    // Profile ids ("c_01J9…") become argv/stdin tokens, so only allow characters that need no quoting.
    [GeneratedRegex("^[A-Za-z0-9_.@-]{1,200}$")]
    private static partial Regex SafeToken();

    private static string Account(string profileId) =>
        SafeToken().IsMatch(profileId) ? profileId : throw new ArgumentException($"Unsupported profile id '{profileId}'.", nameof(profileId));

    internal static string Encode(string secret) => Prefix + Convert.ToBase64String(Encoding.UTF8.GetBytes(secret));

    internal static string Decode(string stored)
    {
        if (stored.StartsWith(Prefix, StringComparison.Ordinal))
        {
            try { return Encoding.UTF8.GetString(Convert.FromBase64String(stored[Prefix.Length..])); }
            catch (FormatException) { }
        }
        return stored; // an item written by something else: use the data as-is
    }

    /// <summary>The line fed to <c>security -i</c>. Contains only safe tokens and hex.</summary>
    internal string AddCommandLine(string profileId, string secret) =>
        $"add-generic-password -U -s {_service} -a {Account(profileId)} -X {Convert.ToHexString(Encoding.ASCII.GetBytes(Encode(secret)))}\n";

    protected override string? ReadPersisted(string profileId)
    {
        var r = _cli.Run(["find-generic-password", "-s", _service, "-a", Account(profileId), "-w"], null);
        if (r.ExitCode != 0)
        {
            // 44 = not found; anything else (access denied, keychain locked and unlock cancelled) behaves as "no password".
            if (r.ExitCode == ItemNotFoundExitCode) _hasCache[profileId] = false;
            return null;
        }
        _hasCache[profileId] = true;
        var data = r.StandardOutput.EndsWith('\n') ? r.StandardOutput[..^1] : r.StandardOutput;
        return Decode(data);
    }

    protected override void WritePersisted(string profileId, string secret)
    {
        var r = _cli.Run(["-i"], AddCommandLine(profileId, secret));
        _hasCache.TryRemove(profileId, out _);
        // `security -i` does not reliably report a failing command through its exit code: read the item back.
        var stored = _cli.Run(["find-generic-password", "-s", _service, "-a", Account(profileId), "-w"], null);
        var expected = Encode(secret);
        if (stored.ExitCode != 0 || stored.StandardOutput.TrimEnd('\n') != expected)
        {
            var why = string.Join(" ", new[] { r.StandardError, stored.StandardError }.Where(s => !string.IsNullOrWhiteSpace(s))).Trim();
            throw new InvalidOperationException(
                "Could not save the password in the macOS Keychain" + (why.Length > 0 ? $": {why}" : "."));
        }
        _hasCache[profileId] = true;
    }

    protected override void DeletePersisted(string profileId)
    {
        _cli.Run(["delete-generic-password", "-s", _service, "-a", Account(profileId)], null);
        _hasCache[profileId] = false; // exit 44 (nothing stored) is fine too
    }

    protected override bool HasPersisted(string profileId)
    {
        if (_hasCache.TryGetValue(profileId, out var known)) return known;
        // Without -w/-g the tool prints only the item's attributes, never the secret.
        var r = _cli.Run(["find-generic-password", "-s", _service, "-a", Account(profileId)], null);
        var has = r.ExitCode == 0;
        if (r.ExitCode is 0 or ItemNotFoundExitCode) _hasCache[profileId] = has; // don't cache "locked/denied"
        return has;
    }
}
