using System.Text.Json.Serialization;

namespace DbStudio.Core.Services;

/// <summary>
/// Wire form of a binary cell: <c>{"$bin":"&lt;base64 of the first 8 KB&gt;","len":N}</c>.
/// The complete value is kept in <see cref="Full"/> (never serialized) so the result store
/// can serve <c>GET .../cell</c> and exports without re-running the query.
/// </summary>
public sealed class BinaryValue
{
    public BinaryValue(byte[] full)
    {
        Full = full;
        var previewLength = Math.Min(full.Length, ValueConverter.MaxBinaryPreviewBytes);
        Bin = Convert.ToBase64String(full, 0, previewLength);
    }

    [JsonPropertyName("$bin")] public string Bin { get; }
    [JsonPropertyName("len")] public long Len => Full.LongLength;
    [JsonIgnore] public byte[] Full { get; }
    [JsonIgnore] public bool IsTruncated => Full.Length > ValueConverter.MaxBinaryPreviewBytes;

    public override string ToString() => Convert.ToBase64String(Full);
}

/// <summary>
/// Wire form of a long text cell: <c>{"$trunc":"&lt;first 32 KB&gt;","len":N}</c> (len in UTF-16 chars).
/// The complete text is kept in <see cref="Full"/> (never serialized).
/// </summary>
public sealed class TruncatedValue
{
    public TruncatedValue(string full)
    {
        Full = full;
        var cut = ValueConverter.MaxStringChars;
        // Never split a surrogate pair.
        if (cut < full.Length && char.IsHighSurrogate(full[cut - 1])) cut--;
        Trunc = full[..cut];
    }

    [JsonPropertyName("$trunc")] public string Trunc { get; }
    [JsonPropertyName("len")] public long Len => Full.Length;
    [JsonIgnore] public string Full { get; }

    public override string ToString() => Full;
}

/// <summary>Wire form of a REF CURSOR column: <c>{"$cursor":true}</c> (not expanded in M1).</summary>
public sealed class CursorValue
{
    public static readonly CursorValue Instance = new();
    private CursorValue() { }

    [JsonPropertyName("$cursor")] public bool Cursor => true;

    public override string ToString() => "(cursor)";
}
