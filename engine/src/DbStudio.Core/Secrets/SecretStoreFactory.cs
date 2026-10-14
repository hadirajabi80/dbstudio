using DbStudio.Core.Platform;
using DbStudio.Core.Services;

namespace DbStudio.Core.Secrets;

/// <summary>Which backend holds saved connection passwords.</summary>
public enum SecretStoreKind
{
    /// <summary>Windows DPAPI, CurrentUser scope (<c>secrets.dat</c>).</summary>
    Dpapi,
    /// <summary>macOS login keychain via <c>/usr/bin/security</c>.</summary>
    Keychain,
    /// <summary>AES-GCM file with a 0600 key file (Linux and other hosts).</summary>
    File,
    /// <summary>Nothing persisted (tests, diagnostics).</summary>
    Memory,
}

/// <summary>
/// Chooses the secret store for the host OS (docs/PLAN.md 2.8): DPAPI on Windows, Keychain on macOS, the
/// <see cref="FileSecretStore"/> elsewhere. <c>DBSTUDIO_SECRET_STORE</c> = <c>dpapi|keychain|file|memory</c>
/// overrides the choice (e.g. <c>memory</c> on a CI runner without an unlocked keychain).
/// </summary>
public static class SecretStoreFactory
{
    public const string OverrideVariable = "DBSTUDIO_SECRET_STORE";

    public static SecretStoreKind Choose(HostOs os, string? overrideValue = null)
    {
        if (!string.IsNullOrWhiteSpace(overrideValue))
        {
            return overrideValue.Trim().ToLowerInvariant() switch
            {
                "dpapi" => SecretStoreKind.Dpapi,
                "keychain" => SecretStoreKind.Keychain,
                "file" => SecretStoreKind.File,
                "memory" => SecretStoreKind.Memory,
                var other => throw new ArgumentException(
                    $"{OverrideVariable}='{other}' is not one of dpapi, keychain, file, memory.", nameof(overrideValue)),
            };
        }
        return os switch
        {
            HostOs.Windows => SecretStoreKind.Dpapi,
            HostOs.MacOS => SecretStoreKind.Keychain,
            _ => SecretStoreKind.File,
        };
    }

    /// <summary>The store for this process (host OS plus the environment override).</summary>
    public static ISecretStore Create(AppPaths paths) =>
        Create(paths, Choose(HostPlatform.Current, Environment.GetEnvironmentVariable(OverrideVariable)));

    public static ISecretStore Create(AppPaths paths, SecretStoreKind kind)
    {
        ArgumentNullException.ThrowIfNull(paths);
        switch (kind)
        {
            case SecretStoreKind.Dpapi:
                if (OperatingSystem.IsWindows()) return new DpapiSecretStore(paths);
                throw new PlatformNotSupportedException("The DPAPI secret store is only available on Windows.");
            case SecretStoreKind.Keychain:
                if (OperatingSystem.IsMacOS()) return new KeychainSecretStore();
                throw new PlatformNotSupportedException("The Keychain secret store is only available on macOS.");
            case SecretStoreKind.File:
                return new FileSecretStore(paths);
            case SecretStoreKind.Memory:
                return new InMemorySecretStore();
            default:
                throw new ArgumentOutOfRangeException(nameof(kind), kind, null);
        }
    }
}
