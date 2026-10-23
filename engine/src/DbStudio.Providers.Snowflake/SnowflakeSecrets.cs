using System.Text.Json.Nodes;
using DbStudio.Core.Models;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Restores the extra password-typed props (<c>privateKeyPassphrase</c>, <c>token</c>) from the secret store before a
/// connection opens. The engine strips every password-typed prop when it saves a profile (docs/PLAN-M2.md D12) but, for
/// relational providers, only the connection test puts them back (<c>ConnectionStore.WithSecrets</c>); sessions, catalog
/// and designer get the bare profile. TODO(WPSF-shared): drop this once the R3 request in docs/wp-notes/WP-SF.md lands.
/// </summary>
public sealed class SnowflakeSecrets(Func<string, string, string?>? lookup = null)
{
    public static readonly IReadOnlyList<string> Fields = ["privateKeyPassphrase", "token"];

    public static readonly SnowflakeSecrets None = new();

    /// <summary>The profile, or a copy with the missing secret props filled in.</summary>
    public ConnectionProfile Hydrate(ConnectionProfile profile)
    {
        if (lookup is null || string.IsNullOrEmpty(profile.Id)) return profile;
        Dictionary<string, JsonNode?>? props = null;
        foreach (var key in Fields)
        {
            if (!string.IsNullOrEmpty(profile.GetString(key))) continue;
            string? secret;
            try { secret = lookup(profile.Id, key); } catch (Exception) { secret = null; }
            if (string.IsNullOrEmpty(secret)) continue;
            props ??= new Dictionary<string, JsonNode?>(profile.Props.Select(kv => KeyValuePair.Create(kv.Key, kv.Value?.DeepClone())));
            props[key] = JsonValue.Create(secret);
        }
        if (props is null) return profile;
        return new ConnectionProfile
        {
            Id = profile.Id, Name = profile.Name, ProviderId = profile.ProviderId, Color = profile.Color, Folder = profile.Folder,
            ReadOnly = profile.ReadOnly, Props = props, HasPassword = profile.HasPassword, SavePassword = profile.SavePassword,
            CreatedAt = profile.CreatedAt, LastUsedAt = profile.LastUsedAt,
        };
    }
}
