using System.Globalization;
using System.Text;

namespace DbStudio.Sources.Redis;

/// <summary>
/// redis-cli argument rules (<c>sdssplitargs</c>): whitespace separates arguments; "double quotes" accept
/// <c>\n \r \t \b \a \\ \" \xHH</c>; 'single quotes' accept only <c>\'</c>; a closing quote must be followed by
/// whitespace or the end of the line; quotes may start in the middle of a word (<c>a"b c"</c> is <c>ab c</c>).
/// Also renders values back with redis-cli quoting (<see cref="Quote"/>) for MONITOR lines, CLI echoes and binary data.
/// </summary>
public static class RedisArgs
{
    /// <summary>Splits a command line. Throws <see cref="FormatException"/> ("Invalid argument(s)") on unbalanced quotes.</summary>
    public static List<byte[]> Parse(string line) => Parse(Encoding.UTF8.GetBytes(line));

    public static List<byte[]> Parse(ReadOnlySpan<byte> line)
    {
        var result = new List<byte[]>();
        var i = 0;
        var cur = new List<byte>();
        while (true)
        {
            while (i < line.Length && IsSpace(line[i])) i++;
            if (i >= line.Length) return result;
            var inDouble = false;
            var inSingle = false;
            var done = false;
            cur.Clear();
            while (!done)
            {
                if (inDouble)
                {
                    if (i >= line.Length) throw new FormatException("Invalid argument(s): unbalanced double quotes.");
                    var c = line[i];
                    if (c == '\\' && i + 3 < line.Length && line[i + 1] == 'x' && IsHex(line[i + 2]) && IsHex(line[i + 3]))
                    {
                        cur.Add((byte)(HexValue(line[i + 2]) * 16 + HexValue(line[i + 3])));
                        i += 3;
                    }
                    else if (c == '\\' && i + 1 < line.Length)
                    {
                        i++;
                        cur.Add(line[i] switch
                        {
                            (byte)'n' => (byte)'\n',
                            (byte)'r' => (byte)'\r',
                            (byte)'t' => (byte)'\t',
                            (byte)'b' => (byte)'\b',
                            (byte)'a' => (byte)'\a',
                            var other => other,
                        });
                    }
                    else if (c == '"')
                    {
                        if (i + 1 < line.Length && !IsSpace(line[i + 1]))
                            throw new FormatException("Invalid argument(s): a closing quote must be followed by a space.");
                        done = true;
                    }
                    else cur.Add(c);
                }
                else if (inSingle)
                {
                    if (i >= line.Length) throw new FormatException("Invalid argument(s): unbalanced single quotes.");
                    var c = line[i];
                    if (c == '\\' && i + 1 < line.Length && line[i + 1] == '\'')
                    {
                        i++;
                        cur.Add((byte)'\'');
                    }
                    else if (c == '\'')
                    {
                        if (i + 1 < line.Length && !IsSpace(line[i + 1]))
                            throw new FormatException("Invalid argument(s): a closing quote must be followed by a space.");
                        done = true;
                    }
                    else cur.Add(c);
                }
                else
                {
                    if (i >= line.Length) { done = true; break; }
                    var c = line[i];
                    if (IsSpace(c)) done = true;
                    else if (c == '"') inDouble = true;
                    else if (c == '\'') inSingle = true;
                    else cur.Add(c);
                }
                if (i < line.Length) i++;
            }
            result.Add(cur.ToArray());
        }
    }

    /// <summary>Parses a line into UTF-8 strings (invalid sequences become U+FFFD).</summary>
    public static List<string> ParseStrings(string line) => Parse(line).Select(b => Encoding.UTF8.GetString(b)).ToList();

    private static bool IsSpace(byte c) => c is (byte)' ' or (byte)'\n' or (byte)'\r' or (byte)'\t' or (byte)'\v' or (byte)'\f';

    private static bool IsHex(byte c) => c is >= (byte)'0' and <= (byte)'9' or >= (byte)'a' and <= (byte)'f' or >= (byte)'A' and <= (byte)'F';

    private static int HexValue(byte c) => c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10;

    /// <summary>redis-cli representation (<c>sdscatrepr</c>): always double-quoted, escapes and <c>\xHH</c> for non-printables.</summary>
    public static string Quote(ReadOnlySpan<byte> value)
    {
        var sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        AppendEscaped(sb, value);
        sb.Append('"');
        return sb.ToString();
    }

    public static string Quote(string value) => Quote(Encoding.UTF8.GetBytes(value));

    /// <summary>Text for display: valid UTF-8 is returned as is; otherwise invalid bytes are written as <c>\xHH</c>.</summary>
    public static string ToDisplay(byte[] value)
    {
        if (IsValidUtf8(value)) return Encoding.UTF8.GetString(value);
        var sb = new StringBuilder(value.Length * 2);
        var i = 0;
        while (i < value.Length)
        {
            var len = Utf8SequenceLength(value, i);
            if (len > 0)
            {
                sb.Append(Encoding.UTF8.GetString(value, i, len));
                i += len;
            }
            else
            {
                sb.Append("\\x").Append(value[i].ToString("x2", CultureInfo.InvariantCulture));
                i++;
            }
        }
        return sb.ToString();
    }

    /// <summary>Quotes an argument only when redis-cli would need it to parse back to the same bytes.</summary>
    public static string QuoteIfNeeded(string value)
    {
        if (value.Length > 0 && value.All(c => c > ' ' && c != '"' && c != '\'' && c != '\\' && c < 0x7f)) return value;
        return Quote(value);
    }

    private static void AppendEscaped(StringBuilder sb, ReadOnlySpan<byte> value)
    {
        foreach (var b in value)
        {
            switch (b)
            {
                case (byte)'\\': sb.Append("\\\\"); break;
                case (byte)'"': sb.Append("\\\""); break;
                case (byte)'\n': sb.Append("\\n"); break;
                case (byte)'\r': sb.Append("\\r"); break;
                case (byte)'\t': sb.Append("\\t"); break;
                case (byte)'\a': sb.Append("\\a"); break;
                case (byte)'\b': sb.Append("\\b"); break;
                default:
                    if (b is >= 0x20 and < 0x7f) sb.Append((char)b);
                    else sb.Append("\\x").Append(b.ToString("x2", CultureInfo.InvariantCulture));
                    break;
            }
        }
    }

    public static bool IsValidUtf8(ReadOnlySpan<byte> value) => System.Text.Unicode.Utf8.IsValid(value);

    /// <summary>True when the bytes are not text: invalid UTF-8 or containing NUL / other C0 controls besides whitespace.</summary>
    public static bool IsBinary(ReadOnlySpan<byte> value)
    {
        if (!IsValidUtf8(value)) return true;
        foreach (var b in value)
            if (b < 0x20 && b is not ((byte)'\n' or (byte)'\r' or (byte)'\t')) return true;
        return false;
    }

    private static int Utf8SequenceLength(byte[] s, int i)
    {
        var b = s[i];
        var len = b < 0x80 ? 1 : (b & 0xE0) == 0xC0 ? 2 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xF8) == 0xF0 ? 4 : 0;
        if (len == 0 || i + len > s.Length) return 0;
        return System.Text.Unicode.Utf8.IsValid(s.AsSpan(i, len)) ? len : 0;
    }
}
