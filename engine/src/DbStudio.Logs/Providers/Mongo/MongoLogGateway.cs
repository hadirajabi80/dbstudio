using System.Reflection;
using System.Text.Json;
using DbStudio.Core.Services;

namespace DbStudio.Logs.Providers.Mongo;

/// <summary>A MongoDB command error (code 13 = Unauthorized, 40573 = change streams need a replica set...).</summary>
public sealed class MongoCommandFailure(int code, string codeName, string message) : Exception(message)
{
    public int Code { get; } = code;
    public string CodeName { get; } = codeName;
    public bool IsUnauthorized => Code is 13 or 18 || CodeName is "Unauthorized";
}

/// <summary>
/// Seam between the Mongo log/activity source and the driver: runs one database command given as relaxed Extended JSON
/// and answers the reply as JSON. The default (<see cref="ReflectionMongoGateway"/>) reaches the M2-M client handle
/// through <c>MongoClientHandle.Database(name)</c> without a compile-time dependency; tests use a fake.
/// </summary>
public interface IMongoLogGateway
{
    Task<JsonElement> RunCommandAsync(LogTarget target, string database, string commandJson, CancellationToken ct);
}

/// <summary>
/// Calls the MongoDB driver by reflection on the shared source client (D2): <c>client.Database(name)</c> (or
/// <c>client.Client.GetDatabase(name)</c>) → <c>IMongoDatabase.RunCommandAsync&lt;BsonDocument&gt;(BsonDocumentCommand)</c>,
/// reply rendered with <c>BsonDocument.ToString()</c> (relaxed Extended JSON in driver 3.x).
/// </summary>
public sealed class ReflectionMongoGateway(SourceClientManager clients) : IMongoLogGateway
{
    public const string MissingAccessor = "The MongoDB client does not expose Database(name) yet (package M2-M); Mongo logs and activity are unavailable.";

    public async Task<JsonElement> RunCommandAsync(LogTarget target, string database, string commandJson, CancellationToken ct)
    {
        var client = await clients.GetAsync(target.ConnectionId, ct).ConfigureAwait(false);
        var db = GetDatabase(client, database) ?? throw EngineException.SourceUnavailable(MissingAccessor);
        var dbType = db.GetType();
        var driver = FindInterface(dbType, "MongoDB.Driver.IMongoDatabase") ?? throw EngineException.SourceUnavailable(MissingAccessor);
        var bsonDocType = Type.GetType("MongoDB.Bson.BsonDocument, MongoDB.Bson") ?? throw EngineException.SourceUnavailable(MissingAccessor);
        var commandType = driver.Assembly.GetType("MongoDB.Driver.BsonDocumentCommand`1")?.MakeGenericType(bsonDocType)
            ?? throw EngineException.SourceUnavailable(MissingAccessor);
        var doc = bsonDocType.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [commandJson]);
        var ctor = commandType.GetConstructors().First(c => c.GetParameters().Length >= 1);
        var args = new object?[ctor.GetParameters().Length];
        args[0] = doc;
        var command = ctor.Invoke(args);
        var run = driver.GetMethods().First(m => m.Name == "RunCommandAsync" && m.IsGenericMethodDefinition && m.GetParameters().Length == 3
            && m.GetParameters()[0].ParameterType.Name.StartsWith("Command", StringComparison.Ordinal)).MakeGenericMethod(bsonDocType);
        object? result;
        try
        {
            var task = (Task)run.Invoke(db, [command, null, ct])!;
            await task.ConfigureAwait(false);
            result = task.GetType().GetProperty("Result")!.GetValue(task);
        }
        catch (Exception ex) when (Unwrap(ex) is { } inner && inner.GetType().Name.Contains("MongoCommandException", StringComparison.Ordinal))
        {
            var code = inner.GetType().GetProperty("Code")?.GetValue(inner) as int? ?? 0;
            var name = inner.GetType().GetProperty("CodeName")?.GetValue(inner) as string ?? "";
            throw new MongoCommandFailure(code, name, inner.Message);
        }
        using var parsed = JsonDocument.Parse(result?.ToString() ?? "{}");
        return parsed.RootElement.Clone();
    }

    private static Exception Unwrap(Exception ex) => ex is TargetInvocationException { InnerException: { } i } ? Unwrap(i) : ex;

    private static Type? FindInterface(Type t, string fullName) =>
        t.FullName == fullName ? t : t.GetInterfaces().FirstOrDefault(i => i.FullName == fullName);

    /// <summary>The <c>IMongoDatabase</c> of a client handle: <c>Database(string)</c>, else <c>Client.GetDatabase(string, null)</c>.</summary>
    internal static object? GetDatabase(object client, string name)
    {
        var t = client.GetType();
        if (t.GetMethod("Database", [typeof(string)]) is { } m) return m.Invoke(client, [name]);
        var inner = t.GetProperty("Client")?.GetValue(client) ?? t.GetProperty("MongoClient")?.GetValue(client);
        var get = inner?.GetType().GetMethods().FirstOrDefault(x => x.Name == "GetDatabase" && x.GetParameters().Length is 1 or 2 && x.GetParameters()[0].ParameterType == typeof(string));
        return get?.Invoke(inner, get.GetParameters().Length == 1 ? [name] : [name, null]);
    }
}
