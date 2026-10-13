using System.Diagnostics;

namespace DbStudio.Host.Infrastructure;

/// <summary><c>--parent-pid</c>: stops the engine when the launching process (Electron main) exits.</summary>
public sealed class ParentWatchdog(EngineOptions options, IHostApplicationLifetime lifetime, ILogger<ParentWatchdog> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (options.ParentPid is not { } pid) return;
        Process? parent;
        try
        {
            parent = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            log.LogWarning("Parent process {Pid} is not running; shutting down", pid);
            lifetime.StopApplication();
            return;
        }

        using (parent)
        {
            try
            {
                // WaitForExitAsync needs access rights some parents deny; poll as a fallback.
                await parent.WaitForExitAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                while (!stoppingToken.IsCancellationRequested && IsAlive(pid))
                    await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }

        if (stoppingToken.IsCancellationRequested) return;
        log.LogInformation("Parent process {Pid} exited; shutting down", pid);
        lifetime.StopApplication();
    }

    private static bool IsAlive(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return !p.HasExited;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return false;
        }
    }
}
