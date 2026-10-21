using DbStudio.Core.Services;

namespace DbStudio.Sources.Kafka;

/// <summary>Maps gateway failures to the REST error envelope (docs/PLAN-M2.md 1.1 error codes).</summary>
public static class KafkaErrors
{
    public static EngineException ToEngine(KafkaGatewayException ex, string? subject = null) => ex.Kind switch
    {
        KafkaErrorKind.Unreachable => EngineException.SourceUnavailable($"Cannot reach the Kafka brokers: {ex.Message}"),
        KafkaErrorKind.Timeout => EngineException.SourceUnavailable($"Kafka did not answer in time: {ex.Message}"),
        KafkaErrorKind.Authentication => EngineException.SourceUnavailable($"Kafka authentication failed: {ex.Message}"),
        KafkaErrorKind.UnknownTopic => new EngineException(404, ErrorCodes.NotFound, subject is null ? ex.Message : $"Topic '{subject}' was not found ({ex.Message})."),
        KafkaErrorKind.UnknownGroup => new EngineException(404, ErrorCodes.NotFound, subject is null ? ex.Message : $"Consumer group '{subject}' was not found."),
        KafkaErrorKind.TopicExists => new EngineException(409, ErrorCodes.Validation, $"Topic '{subject}' already exists.", new { field = "name" }),
        KafkaErrorKind.GroupNotEmpty => new EngineException(409, ErrorCodes.GroupActive,
            $"The consumer group{(subject is null ? "" : $" '{subject}'")} is active; stop its consumers first ({ex.Message})."),
        KafkaErrorKind.Authorization => EngineException.Privilege($"Kafka denied the request: {ex.Message}", "Kafka ACL for this operation"),
        KafkaErrorKind.InvalidRequest or KafkaErrorKind.PolicyViolation => EngineException.Validation(ex.Message),
        _ => new EngineException(422, ErrorCodes.ProviderError, ex.Message),
    };

    /// <summary>Runs a gateway call and maps its failure.</summary>
    public static async Task<T> Call<T>(Func<Task<T>> op, string? subject = null)
    {
        try { return await op().ConfigureAwait(false); }
        catch (KafkaGatewayException ex) { throw ToEngine(ex, subject); }
    }

    public static async Task Call(Func<Task> op, string? subject = null)
    {
        try { await op().ConfigureAwait(false); }
        catch (KafkaGatewayException ex) { throw ToEngine(ex, subject); }
    }
}
