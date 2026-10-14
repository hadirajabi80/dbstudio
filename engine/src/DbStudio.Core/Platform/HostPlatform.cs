namespace DbStudio.Core.Platform;

/// <summary>The operating systems the engine distinguishes (data directory, secret store, auth labels).</summary>
public enum HostOs
{
    Windows,
    MacOS,
    Linux,
    /// <summary>FreeBSD and anything else: treated like Linux (XDG paths, file-based secret store).</summary>
    Other,
}

public static class HostPlatform
{
    /// <summary>The OS the engine is running on.</summary>
    public static HostOs Current { get; } =
        OperatingSystem.IsWindows() ? HostOs.Windows
        : OperatingSystem.IsMacOS() ? HostOs.MacOS
        : OperatingSystem.IsLinux() ? HostOs.Linux
        : HostOs.Other;
}
