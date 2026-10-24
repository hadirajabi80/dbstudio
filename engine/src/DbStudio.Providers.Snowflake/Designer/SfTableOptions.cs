using System.Globalization;
using DbStudio.Core.Designer;

namespace DbStudio.Providers.Snowflake.Designer;

/// <summary>
/// Snowflake table options the designer edits (<c>TableOptions.Extra</c>): <c>kind</c> = "transient" (CREATE TRANSIENT TABLE),
/// <c>retentionDays</c> (DATA_RETENTION_TIME_IN_DAYS, 0..90) and <c>changeTracking</c> ("true" / "false").
/// </summary>
public sealed record SfTableOptions(bool Transient = false, int? RetentionDays = null, bool? ChangeTracking = null)
{
    public static SfTableOptions From(TableModel model)
    {
        var x = model.Options.Extra;
        if (x is null || x.Count == 0) return new SfTableOptions();
        string? Get(string key) => x.FirstOrDefault(kv => kv.Key.Equals(key, StringComparison.OrdinalIgnoreCase)).Value is { } v && !string.IsNullOrWhiteSpace(v) ? v.Trim() : null;
        int? days = int.TryParse(Get("retentionDays"), NumberStyles.None, CultureInfo.InvariantCulture, out var d) && d is >= 0 and <= 90 ? d : null;
        bool? tracking = bool.TryParse(Get("changeTracking"), out var c) ? c : null;
        return new SfTableOptions(string.Equals(Get("kind"), "transient", StringComparison.OrdinalIgnoreCase), days, tracking);
    }

    /// <summary>The options of a SHOW TABLES row (kind, retention_time, change_tracking) as designer <c>Extra</c>; null when all are defaults.</summary>
    public static Dictionary<string, string>? ToExtra(string? kind, string? retentionTime, string? changeTracking)
    {
        var extra = new Dictionary<string, string>();
        if (string.Equals(kind, "TRANSIENT", StringComparison.OrdinalIgnoreCase)) extra["kind"] = "transient";
        if (int.TryParse(retentionTime, NumberStyles.None, CultureInfo.InvariantCulture, out var days)) extra["retentionDays"] = days.ToString(CultureInfo.InvariantCulture);
        if (string.Equals(changeTracking, "ON", StringComparison.OrdinalIgnoreCase) || string.Equals(changeTracking, "true", StringComparison.OrdinalIgnoreCase)) extra["changeTracking"] = "true";
        return extra.Count == 0 ? null : extra;
    }
}
