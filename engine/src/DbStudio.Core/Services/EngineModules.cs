using System.Reflection;
using DbStudio.Core.Providers;

namespace DbStudio.Core.Services;

/// <summary>
/// M2 (docs/PLAN-M2.md D4): finds the <see cref="IEngineModule"/>s of the DbStudio assemblies. Discovery walks the given
/// root assemblies and, recursively, every referenced assembly whose name starts with "DbStudio." (the engine is not
/// trimmed, so reflection is safe). The C# compiler drops references to assemblies whose types are never used, so the
/// Host passes one anchor type per module assembly as roots (<c>Host/ModuleAssemblies.cs</c>); a new module class in an
/// already referenced project (e.g. Core's <c>DiagramsModule</c>) needs no Host change.
/// </summary>
public static class EngineModules
{
    public const string AssemblyPrefix = "DbStudio.";

    /// <summary>
    /// Instantiates every non-abstract <see cref="IEngineModule"/> with a public parameterless constructor, once per type,
    /// ordered by full type name (deterministic registration order).
    /// </summary>
    public static IReadOnlyList<IEngineModule> Discover(params Assembly[] roots)
    {
        var assemblies = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);
        var queue = new Queue<Assembly>(roots.Where(a => a is not null));
        while (queue.Count > 0)
        {
            var a = queue.Dequeue();
            var name = a.GetName().Name ?? a.FullName ?? "";
            if (!assemblies.TryAdd(name, a)) continue;
            foreach (var reference in a.GetReferencedAssemblies())
            {
                if (reference.Name is null || !reference.Name.StartsWith(AssemblyPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                if (assemblies.ContainsKey(reference.Name)) continue;
                try
                {
                    queue.Enqueue(Assembly.Load(reference));
                }
                catch (Exception ex) when (ex is FileNotFoundException or FileLoadException or BadImageFormatException)
                {
                    // An optional reference that is not deployed: skip it.
                }
            }
        }

        var modules = new List<IEngineModule>();
        foreach (var type in assemblies.Values.SelectMany(LoadableTypes).Distinct().OrderBy(t => t.FullName, StringComparer.Ordinal))
        {
            if (!typeof(IEngineModule).IsAssignableFrom(type) || type.IsAbstract || type.IsInterface || type.ContainsGenericParameters) continue;
            if (type.GetConstructor(Type.EmptyTypes) is null) continue;
            modules.Add((IEngineModule)Activator.CreateInstance(type)!);
        }
        return modules;
    }

    private static IEnumerable<Type> LoadableTypes(Assembly a)
    {
        try
        {
            return a.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            return ex.Types.Where(t => t is not null)!;
        }
    }
}
