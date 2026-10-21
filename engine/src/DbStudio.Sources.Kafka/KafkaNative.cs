using System.Runtime.InteropServices;
using Confluent.Kafka;

namespace DbStudio.Sources.Kafka;

/// <summary>
/// librdkafka loading (docs/PLAN-M2.md D8). win-x64: the single-file engine self-extracts librdkafka.dll and its
/// dependencies (libcrypto, libssl, libcurl, zlib, zstd, the VC runtime) to <c>%TEMP%\.net\DbStudio.Engine\&lt;hash&gt;</c> and
/// the runtime's native probing finds them there. macOS: <c>librdkafka.dylib</c> ships next to the apphost (not
/// self-extracted, so it is signed with the app); it is loaded explicitly from <see cref="AppContext.BaseDirectory"/> so
/// the load never depends on Confluent's probing of an assembly location (empty in single-file apps). Development builds
/// (bin/…/runtimes/&lt;rid&gt;/native) use the default resolution.
/// </summary>
public static class KafkaNative
{
    private static readonly object Gate = new();
    private static bool _done;

    /// <summary>The explicit library path used, or null when the default resolution applies.</summary>
    public static string? LoadedFrom { get; private set; }

    public static void EnsureLoaded()
    {
        if (_done) return;
        lock (Gate)
        {
            if (_done) return;
            var name = RuntimeInformation.IsOSPlatform(OSPlatform.OSX) ? "librdkafka.dylib"
                : RuntimeInformation.IsOSPlatform(OSPlatform.Linux) ? "librdkafka.so" : null;
            var path = name is null ? null : Path.Combine(AppContext.BaseDirectory, name);
            if (path is not null && File.Exists(path))
            {
                try
                {
                    Library.Load(path);
                    LoadedFrom = path;
                }
                catch (InvalidOperationException)
                {
                    // Already loaded (e.g. by an earlier default resolution): fine.
                }
            }
            _done = true;
        }
    }

    /// <summary>librdkafka version string; forces the native load.</summary>
    public static string Version
    {
        get
        {
            EnsureLoaded();
            return Library.VersionString;
        }
    }
}
