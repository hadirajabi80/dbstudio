using System.Globalization;
using System.Text;
using MongoDB.Bson;

namespace DbStudio.Sources.Mongo;

/// <summary>A query-bar / import parse error with its position (0-based offset, 1-based line and column).</summary>
public sealed class ShellJsonException(string message, string field, int offset, int line, int col) : FormatException(message)
{
    public string Field { get; } = field;
    public int Offset { get; } = offset;
    public int Line { get; } = line;
    public int Col { get; } = col;
}

/// <summary>
/// mongosh-style JSON (docs/PLAN-M2.md 6.3): JSON plus comments, trailing commas, single quotes, unquoted keys, regex
/// literals, <c>NaN</c>/<c>Infinity</c>/<c>undefined</c>, the shell helpers (<c>ObjectId("…")</c>, <c>ISODate("…")</c>,
/// <c>NumberLong(…)</c>, <c>NumberDecimal("…")</c>, <c>BinData(…)</c>, <c>UUID(…)</c>, <c>Timestamp(…)</c>, …) and the
/// canonical / relaxed Extended JSON wrappers (<c>{"$oid": …}</c>, <c>{"$date": …}</c>, …), parsed straight to BSON.
/// Hand-written tokenizer + recursive descent so errors carry positions.
/// </summary>
public static class ShellJson
{
    /// <summary>Parses one value; empty or whitespace-only text (comments included) is <c>{}</c>.</summary>
    public static BsonValue Parse(string? text, string field)
    {
        var p = new Parser(text ?? "", field);
        p.SkipWs();
        if (p.AtEnd) return new BsonDocument();
        var v = p.ParseValue();
        p.SkipWs();
        if (!p.AtEnd) throw p.Error("Unexpected text after the value");
        return v;
    }

    /// <summary>Parses a document; empty text is <c>{}</c>; any other top-level value is an error.</summary>
    public static BsonDocument ParseDocument(string? text, string field)
    {
        var p = new Parser(text ?? "", field);
        p.SkipWs();
        if (p.AtEnd) return new BsonDocument();
        var start = p.Pos;
        var v = p.ParseValue();
        if (v is not BsonDocument d) throw p.ErrorAt(start, $"Expected a document {{ … }}, found {Describe(v)}");
        p.SkipWs();
        if (!p.AtEnd) throw p.Error("Unexpected text after the document");
        return d;
    }

    /// <summary>
    /// Reads a sequence of top-level values: a JSON array (yields its elements) or concatenated / newline-delimited
    /// values (optionally comma-separated). Stops at the first syntax error by throwing it.
    /// </summary>
    public static IEnumerable<BsonValue> ParseMany(string text, string field)
    {
        var p = new Parser(text, field);
        p.SkipWs();
        if (p.AtEnd) yield break;
        if (p.Peek == '[')
        {
            p.Advance();
            while (true)
            {
                p.SkipWs();
                if (p.AtEnd) throw p.Error("Unterminated array: expected ']'");
                if (p.Peek == ']')
                {
                    p.Advance();
                    break;
                }
                yield return p.ParseValue();
                p.SkipWs();
                if (p.Peek == ',') p.Advance();
                else if (p.Peek != ']') throw p.Error("Expected ',' or ']' in the array");
            }
            p.SkipWs();
            if (!p.AtEnd) throw p.Error("Unexpected text after the array");
            yield break;
        }
        while (true)
        {
            p.SkipWs();
            if (p.AtEnd) yield break;
            yield return p.ParseValue();
            p.SkipWs();
            if (!p.AtEnd && p.Peek == ',') p.Advance();
        }
    }

    internal static string Describe(BsonValue v) => v.BsonType switch
    {
        BsonType.Array => "an array",
        BsonType.String => "a string",
        BsonType.Null => "null",
        _ => "a " + BsonKit.TypeAlias(v),
    };

    private sealed class Parser(string text, string field)
    {
        private readonly string _s = text;
        public int Pos;

        public bool AtEnd => Pos >= _s.Length;
        public char Peek => Pos < _s.Length ? _s[Pos] : '\0';
        private char PeekAt(int k) => Pos + k < _s.Length ? _s[Pos + k] : '\0';
        public void Advance() => Pos++;

        public ShellJsonException Error(string message) => ErrorAt(Pos, message);

        public ShellJsonException ErrorAt(int offset, string message)
        {
            offset = Math.Clamp(offset, 0, _s.Length);
            int line = 1, col = 1;
            for (var i = 0; i < offset; i++)
            {
                if (_s[i] == '\n')
                {
                    line++;
                    col = 1;
                }
                else col++;
            }
            var near = offset < _s.Length ? $" near '{Snippet(offset)}'" : " at the end of the text";
            return new ShellJsonException($"{message}{near} (line {line}, column {col}).", field, offset, line, col);
        }

        private string Snippet(int offset)
        {
            var end = Math.Min(_s.Length, offset + 12);
            var s = _s[offset..end];
            var nl = s.IndexOf('\n');
            return nl >= 0 ? s[..nl] : s;
        }

        public void SkipWs()
        {
            while (Pos < _s.Length)
            {
                var c = _s[Pos];
                if (char.IsWhiteSpace(c) || c == '﻿')
                {
                    Pos++;
                }
                else if (c == '/' && PeekAt(1) == '/')
                {
                    while (Pos < _s.Length && _s[Pos] != '\n') Pos++;
                }
                else if (c == '/' && PeekAt(1) == '*')
                {
                    var end = _s.IndexOf("*/", Pos + 2, StringComparison.Ordinal);
                    if (end < 0) throw Error("Unterminated /* comment");
                    Pos = end + 2;
                }
                else break;
            }
        }

        private void Expect(char c, string what)
        {
            SkipWs();
            if (Peek != c) throw Error($"Expected '{c}' {what}");
            Pos++;
        }

        public BsonValue ParseValue()
        {
            SkipWs();
            if (AtEnd) throw Error("Expected a value");
            var c = Peek;
            switch (c)
            {
                case '{': return ParseObject();
                case '[': return ParseArray();
                case '"' or '\'': return new BsonString(ParseString());
                case '/': return ParseRegexLiteral();
                case '-' or '+':
                {
                    var start = Pos;
                    Pos++;
                    SkipWs();
                    if (MatchWord("Infinity")) return new BsonDouble(c == '-' ? double.NegativeInfinity : double.PositiveInfinity);
                    if (char.IsDigit(Peek) || Peek == '.')
                    {
                        var v = ParseNumber();
                        return c == '-' ? Negate(v, start) : v;
                    }
                    throw ErrorAt(start, "Expected a number after the sign");
                }
            }
            if (char.IsDigit(c) || c == '.') return ParseNumber();
            if (IsIdentStart(c)) return ParseIdentifierValue();
            throw Error($"Unexpected character '{c}'");
        }

        private BsonValue Negate(BsonValue v, int start) => v switch
        {
            BsonInt32 i => i.Value == int.MinValue ? new BsonInt64(-(long)i.Value) : new BsonInt32(-i.Value),
            BsonInt64 l => NegLong(l.Value),
            BsonDouble d when d.Value == 9223372036854775808d => new BsonInt64(long.MinValue),
            BsonDouble d => new BsonDouble(-d.Value),
            _ => throw ErrorAt(start, "Expected a number after the sign"),
        };

        private static BsonValue NegLong(long v)
        {
            var n = -v;
            return n >= int.MinValue && n <= int.MaxValue ? new BsonInt32((int)n) : new BsonInt64(n);
        }

        private bool MatchWord(string word)
        {
            if (string.CompareOrdinal(_s, Pos, word, 0, word.Length) != 0) return false;
            var after = Pos + word.Length;
            if (after < _s.Length && IsIdentPart(_s[after])) return false;
            Pos = after;
            return true;
        }

        private static bool IsIdentStart(char c) => char.IsLetter(c) || c == '_' || c == '$';
        private static bool IsIdentPart(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '$';
        private static bool IsKeyChar(char c) => char.IsLetterOrDigit(c) || c == '_' || c == '$' || c == '.';

        private BsonValue ParseObject()
        {
            var open = Pos;
            Pos++; // {
            var doc = new BsonDocument(allowDuplicateNames: false);
            while (true)
            {
                SkipWs();
                if (AtEnd) throw ErrorAt(open, "Unterminated document: missing '}'");
                if (Peek == '}')
                {
                    Pos++;
                    break;
                }
                var keyPos = Pos;
                string key;
                if (Peek is '"' or '\'') key = ParseString();
                else if (IsKeyChar(Peek))
                {
                    var start = Pos;
                    while (!AtEnd && IsKeyChar(Peek)) Pos++;
                    key = _s[start..Pos];
                }
                else throw Error("Expected a field name");
                SkipWs();
                if (Peek != ':') throw Error($"Expected ':' after the field name '{key}'");
                Pos++;
                var value = ParseValue();
                if (doc.Contains(key)) throw ErrorAt(keyPos, $"Duplicate field name '{key}'");
                doc.Add(key, value);
                SkipWs();
                if (Peek == ',')
                {
                    Pos++;
                    continue;
                }
                if (Peek == '}')
                {
                    Pos++;
                    break;
                }
                if (AtEnd) throw ErrorAt(open, "Unterminated document: missing '}'");
                throw Error("Expected ',' or '}' in the document");
            }
            return ConvertWrapper(doc, open);
        }

        private BsonArray ParseArray()
        {
            var open = Pos;
            Pos++; // [
            var arr = new BsonArray();
            while (true)
            {
                SkipWs();
                if (AtEnd) throw ErrorAt(open, "Unterminated array: missing ']'");
                if (Peek == ']')
                {
                    Pos++;
                    break;
                }
                arr.Add(ParseValue());
                SkipWs();
                if (Peek == ',')
                {
                    Pos++;
                    continue;
                }
                if (Peek == ']')
                {
                    Pos++;
                    break;
                }
                if (AtEnd) throw ErrorAt(open, "Unterminated array: missing ']'");
                throw Error("Expected ',' or ']' in the array");
            }
            return arr;
        }

        private string ParseString()
        {
            var open = Pos;
            var quote = _s[Pos++];
            var sb = new StringBuilder();
            while (true)
            {
                if (AtEnd) throw ErrorAt(open, "Unterminated string");
                var c = _s[Pos++];
                if (c == quote) break;
                if (c == '\n') throw ErrorAt(open, "Unterminated string (line break inside the quotes)");
                if (c != '\\')
                {
                    sb.Append(c);
                    continue;
                }
                if (AtEnd) throw ErrorAt(open, "Unterminated string");
                var e = _s[Pos++];
                switch (e)
                {
                    case 'n': sb.Append('\n'); break;
                    case 't': sb.Append('\t'); break;
                    case 'r': sb.Append('\r'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'v': sb.Append('\v'); break;
                    case '0' when !char.IsDigit(Peek): sb.Append('\0'); break;
                    case '\r':
                        if (Peek == '\n') Pos++;
                        break; // line continuation
                    case '\n': break;
                    case 'x':
                        sb.Append((char)ReadHex(2, Pos - 2));
                        break;
                    case 'u':
                        if (Peek == '{')
                        {
                            var at = Pos - 2;
                            Pos++;
                            var start = Pos;
                            while (!AtEnd && Peek != '}') Pos++;
                            if (AtEnd || !int.TryParse(_s[start..Pos], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var cp)
                                || cp > 0x10FFFF)
                                throw ErrorAt(at, "Invalid \\u{…} escape");
                            Pos++;
                            sb.Append(char.ConvertFromUtf32(cp));
                        }
                        else sb.Append((char)ReadHex(4, Pos - 2));
                        break;
                    default: sb.Append(e); break; // \" \' \\ \/ and JS identity escapes
                }
            }
            return sb.ToString();
        }

        private int ReadHex(int digits, int at)
        {
            if (Pos + digits > _s.Length || !int.TryParse(_s.AsSpan(Pos, digits), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v))
                throw ErrorAt(at, "Invalid escape sequence");
            Pos += digits;
            return v;
        }

        private BsonValue ParseNumber()
        {
            var start = Pos;
            if (Peek == '0' && (PeekAt(1) is 'x' or 'X'))
            {
                Pos += 2;
                var hs = Pos;
                while (!AtEnd && Uri.IsHexDigit(Peek)) Pos++;
                if (hs == Pos || !long.TryParse(_s[hs..Pos], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var hv))
                    throw ErrorAt(start, "Invalid hexadecimal number");
                return hv is >= int.MinValue and <= int.MaxValue ? new BsonInt32((int)hv) : new BsonInt64(hv);
            }
            var isFloat = false;
            while (!AtEnd && char.IsDigit(Peek)) Pos++;
            if (Peek == '.')
            {
                isFloat = true;
                Pos++;
                while (!AtEnd && char.IsDigit(Peek)) Pos++;
            }
            if (Peek is 'e' or 'E')
            {
                isFloat = true;
                Pos++;
                if (Peek is '+' or '-') Pos++;
                var es = Pos;
                while (!AtEnd && char.IsDigit(Peek)) Pos++;
                if (es == Pos) throw ErrorAt(start, "Invalid number exponent");
            }
            var token = _s[start..Pos];
            if (token == "." || token.Length == 0) throw ErrorAt(start, "Invalid number");
            if (!AtEnd && IsIdentStart(Peek)) throw Error("Invalid number");
            if (!isFloat && long.TryParse(token, NumberStyles.None, CultureInfo.InvariantCulture, out var l))
                return l <= int.MaxValue ? new BsonInt32((int)l) : new BsonInt64(l);
            if (!isFloat && token == "9223372036854775808") return new BsonDouble(9223372036854775808d);
            if (double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out var d)) return new BsonDouble(d);
            throw ErrorAt(start, "Invalid number");
        }

        private BsonValue ParseRegexLiteral()
        {
            var open = Pos;
            Pos++; // /
            var sb = new StringBuilder();
            var inClass = false;
            while (true)
            {
                if (AtEnd || Peek == '\n') throw ErrorAt(open, "Unterminated regular expression");
                var c = _s[Pos++];
                if (c == '\\')
                {
                    if (AtEnd) throw ErrorAt(open, "Unterminated regular expression");
                    sb.Append(c).Append(_s[Pos++]);
                    continue;
                }
                if (c == '[') inClass = true;
                else if (c == ']') inClass = false;
                else if (c == '/' && !inClass) break;
                sb.Append(c);
            }
            if (sb.Length == 0) throw ErrorAt(open, "Empty regular expression");
            var fs = Pos;
            while (!AtEnd && char.IsLetter(Peek)) Pos++;
            return new BsonRegularExpression(sb.ToString(), Flags(_s[fs..Pos], fs));
        }

        private string Flags(string flags, int at)
        {
            foreach (var f in flags)
                if ("imxsu".IndexOf(f) < 0) throw ErrorAt(at, $"Invalid regular expression flag '{f}' (allowed: i, m, x, s, u)");
            return new string(flags.Distinct().OrderBy(c => c).ToArray());
        }

        private BsonValue ParseIdentifierValue()
        {
            var start = Pos;
            var name = ReadIdent();
            if (name == "new")
            {
                SkipWs();
                if (!IsIdentStart(Peek)) throw Error("Expected a constructor name after 'new'");
                start = Pos;
                name = ReadIdent();
            }
            switch (name)
            {
                case "true": return BsonBoolean.True;
                case "false": return BsonBoolean.False;
                case "null": return BsonNull.Value;
                case "undefined": return BsonUndefined.Value;
                case "NaN": return new BsonDouble(double.NaN);
                case "Infinity": return new BsonDouble(double.PositiveInfinity);
            }
            if (name == "Date" && Peek == '.')
            {
                Pos++;
                var member = ReadIdent();
                if (member != "now") throw ErrorAt(start, $"Unknown helper 'Date.{member}'");
                var args0 = ReadArgs(start, name);
                if (args0.Count != 0) throw ErrorAt(start, "Date.now() takes no arguments");
                return new BsonDateTime(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            }
            SkipWs();
            var hasArgs = Peek == '(';
            if (!hasArgs)
            {
                if (name is "MinKey") return BsonMinKey.Value;
                if (name is "MaxKey") return BsonMaxKey.Value;
                throw ErrorAt(start, $"Unknown identifier '{name}' (strings need quotes)");
            }
            var args = ReadArgs(start, name);
            try
            {
                return Helper(name, args, start);
            }
            catch (ShellJsonException)
            {
                throw;
            }
            catch (Exception ex) when (ex is FormatException or OverflowException or ArgumentException or InvalidCastException)
            {
                throw ErrorAt(start, $"Invalid {name}(…): {ex.Message.TrimEnd('.')}");
            }
        }

        private string ReadIdent()
        {
            var s = Pos;
            while (!AtEnd && IsIdentPart(Peek)) Pos++;
            return _s[s..Pos];
        }

        private List<BsonValue> ReadArgs(int at, string name)
        {
            Expect('(', $"after {name}");
            var args = new List<BsonValue>();
            while (true)
            {
                SkipWs();
                if (AtEnd) throw ErrorAt(at, $"Unterminated {name}(…)");
                if (Peek == ')')
                {
                    Pos++;
                    break;
                }
                args.Add(ParseValue());
                SkipWs();
                if (Peek == ',')
                {
                    Pos++;
                    continue;
                }
                if (Peek == ')')
                {
                    Pos++;
                    break;
                }
                throw Error($"Expected ',' or ')' in {name}(…)");
            }
            return args;
        }

        private BsonValue Helper(string name, List<BsonValue> a, int at)
        {
            void Arity(int min, int max)
            {
                if (a.Count < min || a.Count > max)
                    throw ErrorAt(at, min == max ? $"{name}() takes {min} argument(s)" : $"{name}() takes {min} to {max} arguments");
            }

            string Str(int i)
            {
                if (a[i] is BsonString s) return s.Value;
                throw ErrorAt(at, $"{name}() expects a string argument");
            }

            switch (name)
            {
                case "ObjectId":
                    Arity(0, 1);
                    if (a.Count == 0) return ObjectId.GenerateNewId();
                    var hex = Str(0);
                    if (!ObjectId.TryParse(hex, out var oid)) throw ErrorAt(at, "ObjectId() needs 24 hexadecimal characters");
                    return oid;
                case "ISODate" or "Date":
                    Arity(0, 1);
                    if (a.Count == 0) return new BsonDateTime(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    if (BsonKit.IsNumber(a[0])) return new BsonDateTime((long)BsonKit.ToDouble(a[0]));
                    return ParseDate(Str(0), at);
                case "NumberLong" or "Long":
                    Arity(1, 2);
                    if (name == "Long" && a.Count == 2) // Long(low, high)
                        return new BsonInt64(((long)a[1].ToInt32() << 32) | (uint)a[0].ToInt32());
                    return a[0] switch
                    {
                        BsonString s => new BsonInt64(long.Parse(s.Value.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture)),
                        BsonInt32 i => new BsonInt64(i.Value),
                        BsonInt64 l => l,
                        BsonDouble d when Math.Abs(d.Value) < 9.2e18 && Math.Floor(d.Value) == d.Value => new BsonInt64((long)d.Value),
                        _ => throw ErrorAt(at, $"{name}() expects an integer or a string"),
                    };
                case "NumberInt" or "Int32":
                    Arity(1, 1);
                    return a[0] switch
                    {
                        BsonString s => new BsonInt32(int.Parse(s.Value.Trim(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture)),
                        BsonInt32 i => i,
                        BsonInt64 l when l.Value is >= int.MinValue and <= int.MaxValue => new BsonInt32((int)l.Value),
                        BsonDouble d when d.Value is >= int.MinValue and <= int.MaxValue => new BsonInt32((int)d.Value),
                        _ => throw ErrorAt(at, $"{name}() expects a 32-bit integer"),
                    };
                case "NumberDecimal" or "Decimal128":
                    Arity(1, 1);
                    return a[0] switch
                    {
                        BsonString s => new BsonDecimal128(Decimal128.Parse(s.Value.Trim())),
                        BsonInt32 i => new BsonDecimal128(new Decimal128(i.Value)),
                        BsonInt64 l => new BsonDecimal128(new Decimal128(l.Value)),
                        BsonDouble d => new BsonDecimal128(Decimal128.Parse(d.Value.ToString("R", CultureInfo.InvariantCulture))),
                        _ => throw ErrorAt(at, $"{name}() expects a string"),
                    };
                case "Double":
                    Arity(1, 1);
                    return a[0] switch
                    {
                        BsonString s => new BsonDouble(double.Parse(s.Value, NumberStyles.Float, CultureInfo.InvariantCulture)),
                        _ when BsonKit.IsNumber(a[0]) => new BsonDouble(BsonKit.ToDouble(a[0])),
                        _ => throw ErrorAt(at, "Double() expects a number"),
                    };
                case "BinData":
                {
                    Arity(2, 2);
                    var sub = SubType(a[0], at);
                    return new BsonBinaryData(Convert.FromBase64String(Str(1)), sub);
                }
                case "HexData":
                {
                    Arity(2, 2);
                    var sub = SubType(a[0], at);
                    return new BsonBinaryData(Convert.FromHexString(Str(1)), sub);
                }
                case "UUID":
                    Arity(0, 1);
                    if (a.Count == 0) return new BsonBinaryData(Guid.NewGuid(), GuidRepresentation.Standard);
                    return Uuid(Str(0), at);
                case "MD5":
                {
                    Arity(1, 1);
                    var bytes = Convert.FromHexString(Str(0));
                    if (bytes.Length != 16) throw ErrorAt(at, "MD5() needs 32 hexadecimal characters");
                    return new BsonBinaryData(bytes, BsonBinarySubType.MD5);
                }
                case "Timestamp":
                {
                    Arity(0, 2);
                    if (a.Count == 0) return new BsonTimestamp(0, 0);
                    if (a.Count == 1 && a[0] is BsonDocument td && td.Contains("t") && td.Contains("i"))
                        return new BsonTimestamp(checked((int)(uint)td["t"].ToInt64()), checked((int)(uint)td["i"].ToInt64()));
                    if (a.Count != 2 || !BsonKit.IsNumber(a[0]) || !BsonKit.IsNumber(a[1]))
                        throw ErrorAt(at, "Timestamp() takes (t, i) or ({ t, i })");
                    return new BsonTimestamp(unchecked((int)(uint)a[0].ToInt64()), unchecked((int)(uint)a[1].ToInt64()));
                }
                case "MinKey":
                    Arity(0, 0);
                    return BsonMinKey.Value;
                case "MaxKey":
                    Arity(0, 0);
                    return BsonMaxKey.Value;
                case "RegExp":
                    Arity(1, 2);
                    if (a[0] is BsonRegularExpression re0) return a.Count == 2 ? new BsonRegularExpression(re0.Pattern, Flags(Str(1), at)) : re0;
                    return new BsonRegularExpression(Str(0), a.Count == 2 ? Flags(Str(1), at) : "");
                case "Code":
                    Arity(1, 2);
                    if (a.Count == 2)
                    {
                        if (a[1] is not BsonDocument scope) throw ErrorAt(at, "Code() scope must be a document");
                        return new BsonJavaScriptWithScope(Str(0), scope);
                    }
                    return new BsonJavaScript(Str(0));
                case "DBRef":
                {
                    Arity(2, 3);
                    var r = new BsonDocument { { "$ref", Str(0) }, { "$id", a[1] } };
                    if (a.Count == 3) r.Add("$db", Str(2));
                    return r;
                }
                default:
                    throw ErrorAt(at, $"Unknown helper '{name}(…)'");
            }
        }

        private BsonBinarySubType SubType(BsonValue v, int at)
        {
            var n = v switch
            {
                BsonString s => int.Parse(s.Value, NumberStyles.HexNumber, CultureInfo.InvariantCulture),
                _ when BsonKit.IsNumber(v) => (int)BsonKit.ToDouble(v),
                _ => -1,
            };
            if (n is < 0 or > 255) throw ErrorAt(at, "Binary subtype must be 0–255");
            return (BsonBinarySubType)n;
        }

        private BsonBinaryData Uuid(string s, int at)
        {
            var hex = s.Replace("-", "", StringComparison.Ordinal).Trim('{', '}');
            if (hex.Length != 32 || !hex.All(Uri.IsHexDigit)) throw ErrorAt(at, "UUID() needs 32 hexadecimal characters");
            return new BsonBinaryData(Convert.FromHexString(hex), BsonBinarySubType.UuidStandard);
        }

        private BsonDateTime ParseDate(string s, int at) =>
            TryParseIsoDate(s, out var ms) ? new BsonDateTime(ms) : throw ErrorAt(at, $"'{s}' is not an ISO-8601 date");

        private static readonly string[] s_known = ["$oid", "$date", "$numberLong", "$numberInt", "$numberDouble", "$numberDecimal",
            "$binary", "$uuid", "$regularExpression", "$timestamp", "$minKey", "$maxKey", "$undefined", "$symbol", "$code"];

        /// <summary>Extended JSON wrapper objects → their BSON type (only exact wrapper shapes).</summary>
        private BsonValue ConvertWrapper(BsonDocument d, int at)
        {
            if (d.ElementCount is 0 or > 2) return d;
            var first = d.GetElement(0).Name;
            if (first.Length < 2 || first[0] != '$') return d;
            try
            {
                if (d.ElementCount == 1)
                {
                    var v = d[0];
                    switch (first)
                    {
                        case "$oid":
                            return ObjectId.Parse(v.AsString);
                        case "$date":
                            return v switch
                            {
                                BsonString s when TryParseIsoDate(s.Value, out var ms) => new BsonDateTime(ms),
                                BsonString s => throw ErrorAt(at, $"'{s.Value}' is not an ISO-8601 date"),
                                BsonInt64 l => new BsonDateTime(l.Value),
                                BsonInt32 i => new BsonDateTime(i.Value),
                                BsonDouble dd => new BsonDateTime((long)dd.Value),
                                BsonDateTime dt => dt,
                                _ => throw ErrorAt(at, "Invalid $date"),
                            };
                        case "$numberLong":
                            return new BsonInt64(long.Parse(v.AsString, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture));
                        case "$numberInt":
                            return new BsonInt32(int.Parse(v.AsString, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture));
                        case "$numberDouble":
                            return new BsonDouble(v.AsString switch
                            {
                                "Infinity" => double.PositiveInfinity,
                                "-Infinity" => double.NegativeInfinity,
                                "NaN" => double.NaN,
                                var x => double.Parse(x, NumberStyles.Float, CultureInfo.InvariantCulture),
                            });
                        case "$numberDecimal":
                            return new BsonDecimal128(Decimal128.Parse(v.AsString));
                        case "$binary" when v is BsonDocument b && b.Contains("base64") && b.Contains("subType"):
                            return new BsonBinaryData(Convert.FromBase64String(b["base64"].AsString),
                                (BsonBinarySubType)int.Parse(b["subType"].AsString, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                        case "$uuid":
                            return Uuid(v.AsString, at);
                        case "$regularExpression" when v is BsonDocument r:
                            return new BsonRegularExpression(r["pattern"].AsString, Flags(r.GetValue("options", "").AsString, at));
                        case "$timestamp" when v is BsonDocument t:
                            return new BsonTimestamp(unchecked((int)(uint)t["t"].ToInt64()), unchecked((int)(uint)t["i"].ToInt64()));
                        case "$minKey":
                            return BsonMinKey.Value;
                        case "$maxKey":
                            return BsonMaxKey.Value;
                        case "$undefined":
                            return BsonUndefined.Value;
                        case "$symbol":
                            return BsonSymbolTable.Lookup(v.AsString);
                        case "$code":
                            return new BsonJavaScript(v.AsString);
                    }
                    return d;
                }
                var second = d.GetElement(1).Name;
                if (first == "$binary" && second == "$type")
                    return new BsonBinaryData(Convert.FromBase64String(d[0].AsString),
                        (BsonBinarySubType)int.Parse(d[1].AsString, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                if (first == "$code" && second == "$scope")
                    return new BsonJavaScriptWithScope(d[0].AsString, d[1].AsBsonDocument);
                return d;
            }
            catch (ShellJsonException)
            {
                throw;
            }
            catch (Exception ex) when (ex is FormatException or OverflowException or InvalidCastException or KeyNotFoundException or ArgumentException)
            {
                if (s_known.Contains(first)) throw ErrorAt(at, $"Invalid {first} value: {ex.Message.TrimEnd('.')}");
                return d;
            }
        }
    }

    /// <summary>ISO-8601 date (date only, local-less times are UTC) → milliseconds since the epoch.</summary>
    public static bool TryParseIsoDate(string s, out long ms)
    {
        ms = 0;
        s = s.Trim();
        if (s.Length < 4 || !char.IsDigit(s[0])) return false;
        string[] formats =
        [
            "yyyy-MM-dd", "yyyy-MM-ddTHH:mm", "yyyy-MM-ddTHH:mm:ss", "yyyy-MM-ddTHH:mm:ss.FFFFFFF",
            "yyyy-MM-ddTHH:mmK", "yyyy-MM-ddTHH:mm:ssK", "yyyy-MM-ddTHH:mm:ss.FFFFFFFK",
            "yyyy-MM-dd HH:mm", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss.FFFFFFF", "yyyy-MM-dd HH:mm:ssK", "yyyy-MM-dd HH:mm:ss.FFFFFFFK",
            "yyyy-MM-ddTHH:mm:sszzz", "yyyy-MM-ddTHH:mm:ss.FFFFFFFzzz", "yyyy-MM-ddTHH:mm:sszz", "yyyy-MM-ddTHH:mm:ss.FFFFFFFzz",
            "yyyy-MM-ddTHH:mm:ss'+'HHmm",
        ];
        var normalized = System.Text.RegularExpressions.Regex.Replace(s, @"([+-]\d{2})(\d{2})$", "$1:$2");
        if (!DateTimeOffset.TryParseExact(normalized, formats, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var dto))
            return false;
        ms = dto.ToUnixTimeMilliseconds();
        return true;
    }
}
