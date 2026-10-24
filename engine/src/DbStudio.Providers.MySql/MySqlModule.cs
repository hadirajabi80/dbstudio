using DbStudio.Core.Designer;
using DbStudio.Core.Params;
using DbStudio.Core.Plans;
using DbStudio.Core.Providers;
using DbStudio.Logs;
using DbStudio.Logs.Providers.MySql;
using DbStudio.Logs.Sql;
using DbStudio.Providers.MySql.Designer;
using DbStudio.Providers.MySql.Params;
using DbStudio.Providers.MySql.Plans;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace DbStudio.Providers.MySql;

/// <summary>
/// Composition root of the "mysql" and "mariadb" package (plan-batch3 WP-MY, D6), discovered by <c>EngineModules.Discover</c>
/// through the anchor in <c>Host/ModuleAssemblies.cs</c>: both providers (Dialect.MySql), and under each id the keyed
/// DDL scripter, designer database, plan reader, parameter binder and the log / activity source. No module endpoints:
/// everything MySQL-specific goes through the shared relational APIs.
/// </summary>
public sealed class MySqlModule : IEngineModule
{
    public static readonly IReadOnlyList<string> ProviderIds = ["mysql", "mariadb"];

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddSingleton<IDbProvider, MySqlProvider>();
        services.AddSingleton<IDbProvider, MariaDbProvider>();
        foreach (var id in ProviderIds)
        {
            services.AddKeyedSingleton<IDdlScripter>(id, (_, _) => new MySqlDdlScripter(id));
            services.AddKeyedSingleton<IDesignerDatabase>(id, (_, _) => new MySqlDesignerDatabase(id));
            services.AddKeyedSingleton<IPlanReader>(id, (_, _) => new MySqlPlanReader(id));
            services.AddKeyedSingleton<IParamBinder>(id, MySqlParamBinder.Instance);
            // One log source per id (its facts cache is per connection anyway); ISqlRunnerFactory comes from LogsModule.
            services.AddKeyedSingleton(id, (sp, _) => new MySqlLogSource(sp.GetRequiredService<ISqlRunnerFactory>(), id));
            services.AddKeyedSingleton<ILogSource>(id, (sp, key) => sp.GetRequiredKeyedService<MySqlLogSource>(key));
            services.AddKeyedSingleton<IActivitySource>(id, (sp, key) => sp.GetRequiredKeyedService<MySqlLogSource>(key));
        }
    }

    public void MapEndpoints(RouteGroupBuilder api)
    {
        // No MySQL-specific endpoints (plan-batch3 WP-MY).
    }
}
