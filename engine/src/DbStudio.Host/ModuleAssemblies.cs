using System.Reflection;

namespace DbStudio.Host;

/// <summary>
/// Roots of <see cref="Core.Services.EngineModules.Discover"/> (docs/PLAN-M2.md D4). One anchor type per feature assembly
/// keeps the compile-time reference (the compiler drops references to assemblies whose types are never used); the
/// IEngineModule types inside them are found by reflection, so feature packages never edit Program.cs.
/// </summary>
public static class ModuleAssemblies
{
    public static Assembly[] All { get; } =
    [
        typeof(ModuleAssemblies).Assembly,
        typeof(Core.Services.EngineModules).Assembly,                 // Core (e.g. M2-ER DiagramsModule)
        typeof(Providers.PostgreSql.PostgreSqlProvider).Assembly,     // PG-A (Logs/ sources by M2-L)
        typeof(Sources.Redis.RedisModule).Assembly,                   // M2-R
        typeof(Sources.Mongo.MongoModule).Assembly,                   // M2-M
        typeof(Sources.Kafka.KafkaModule).Assembly,                   // M2-K
        typeof(Logs.LogsModule).Assembly,                             // M2-L
        typeof(Providers.SqlServer.SqlServerProvider).Assembly,
        typeof(Providers.Oracle.OracleProvider).Assembly,
        typeof(Providers.Sqlite.SqliteProvider).Assembly,
        // Batch 3 (plan-batch3 D6): one anchor per package; its module registers the provider, keyed features and endpoints.
        typeof(Providers.MySql.MySqlModule).Assembly,                 // WP-MY (mysql, mariadb)
        typeof(Providers.ClickHouse.ClickHouseModule).Assembly,       // WP-CH
        typeof(Providers.Snowflake.SnowflakeModule).Assembly,         // WP-SF
        typeof(Providers.Cassandra.CassandraModule).Assembly,         // WP-CS
        typeof(Sources.Elasticsearch.ElasticsearchModule).Assembly,   // WP-ES
    ];
}
