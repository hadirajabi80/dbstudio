using MongoDB.Bson;

namespace DbStudio.Sources.Mongo;

/// <summary>
/// BSON helpers shared by the services and the test fake: <c>$type</c> alias names, the server's canonical type order and
/// comparison (numbers compare across int/long/double/decimal), and dotted-path access.
/// </summary>
public static class BsonKit
{
    /// <summary>The <c>$type</c> alias of a BSON value (double, string, object, array, binData, objectId, bool, date, ...).</summary>
    public static string TypeAlias(BsonValue v) => TypeAlias(v.BsonType);

    public static string TypeAlias(BsonType t) => t switch
    {
        BsonType.Double => "double",
        BsonType.String => "string",
        BsonType.Document => "object",
        BsonType.Array => "array",
        BsonType.Binary => "binData",
        BsonType.Undefined => "undefined",
        BsonType.ObjectId => "objectId",
        BsonType.Boolean => "bool",
        BsonType.DateTime => "date",
        BsonType.Null => "null",
        BsonType.RegularExpression => "regex",
        BsonType.JavaScript => "javaScript",
        BsonType.Symbol => "symbol",
        BsonType.JavaScriptWithScope => "javascriptWithScope",
        BsonType.Int32 => "int",
        BsonType.Timestamp => "timestamp",
        BsonType.Int64 => "long",
        BsonType.Decimal128 => "decimal",
        BsonType.MinKey => "minKey",
        BsonType.MaxKey => "maxKey",
        _ => t.ToString(),
    };

    /// <summary>BSON type number → alias (for <c>$type: 2</c>).</summary>
    public static string? TypeAliasOfNumber(int n) => n switch
    {
        1 => "double", 2 => "string", 3 => "object", 4 => "array", 5 => "binData", 6 => "undefined", 7 => "objectId", 8 => "bool",
        9 => "date", 10 => "null", 11 => "regex", 13 => "javaScript", 14 => "symbol", 15 => "javascriptWithScope", 16 => "int",
        17 => "timestamp", 18 => "long", 19 => "decimal", -1 => "minKey", 127 => "maxKey",
        _ => null,
    };

    public static bool IsNumber(BsonValue v) => v.BsonType is BsonType.Int32 or BsonType.Int64 or BsonType.Double or BsonType.Decimal128;

    /// <summary>Rank in the server's comparison order (MinKey &lt; null &lt; numbers &lt; strings &lt; object &lt; array &lt; ...).</summary>
    public static int Rank(BsonValue v) => v.BsonType switch
    {
        BsonType.MinKey => 1,
        BsonType.Undefined or BsonType.Null => 2,
        BsonType.Int32 or BsonType.Int64 or BsonType.Double or BsonType.Decimal128 => 3,
        BsonType.String or BsonType.Symbol => 4,
        BsonType.Document => 5,
        BsonType.Array => 6,
        BsonType.Binary => 7,
        BsonType.ObjectId => 8,
        BsonType.Boolean => 9,
        BsonType.DateTime => 10,
        BsonType.Timestamp => 11,
        BsonType.RegularExpression => 12,
        BsonType.JavaScript => 13,
        BsonType.JavaScriptWithScope => 14,
        BsonType.MaxKey => 100,
        _ => 50,
    };

    /// <summary>Total order over BSON values (server sort semantics, arrays compared element-wise).</summary>
    public static int Compare(BsonValue a, BsonValue b)
    {
        var ra = Rank(a);
        var rb = Rank(b);
        if (ra != rb) return ra.CompareTo(rb);
        switch (ra)
        {
            case 3: return CompareNumbers(a, b);
            case 4: return string.CompareOrdinal(StringOf(a), StringOf(b));
            case 5:
            {
                var da = a.AsBsonDocument;
                var db = b.AsBsonDocument;
                for (var i = 0; i < Math.Min(da.ElementCount, db.ElementCount); i++)
                {
                    var ea = da.GetElement(i);
                    var eb = db.GetElement(i);
                    var c = Rank(ea.Value).CompareTo(Rank(eb.Value));
                    if (c != 0) return c;
                    c = string.CompareOrdinal(ea.Name, eb.Name);
                    if (c != 0) return c;
                    c = Compare(ea.Value, eb.Value);
                    if (c != 0) return c;
                }
                return da.ElementCount.CompareTo(db.ElementCount);
            }
            case 6:
            {
                var aa = a.AsBsonArray;
                var ab = b.AsBsonArray;
                for (var i = 0; i < Math.Min(aa.Count, ab.Count); i++)
                {
                    var c = Compare(aa[i], ab[i]);
                    if (c != 0) return c;
                }
                return aa.Count.CompareTo(ab.Count);
            }
            case 7:
            {
                var ba = a.AsBsonBinaryData;
                var bb = b.AsBsonBinaryData;
                var c = ba.Bytes.Length.CompareTo(bb.Bytes.Length);
                if (c != 0) return c;
                c = ((int)ba.SubType).CompareTo((int)bb.SubType);
                return c != 0 ? c : ba.Bytes.AsSpan().SequenceCompareTo(bb.Bytes);
            }
            case 8: return a.AsObjectId.CompareTo(b.AsObjectId);
            case 9: return a.AsBoolean.CompareTo(b.AsBoolean);
            case 10: return a.AsBsonDateTime.MillisecondsSinceEpoch.CompareTo(b.AsBsonDateTime.MillisecondsSinceEpoch);
            case 11: return a.AsBsonTimestamp.Value.CompareTo(b.AsBsonTimestamp.Value);
            case 12:
            {
                var c = string.CompareOrdinal(a.AsBsonRegularExpression.Pattern, b.AsBsonRegularExpression.Pattern);
                return c != 0 ? c : string.CompareOrdinal(a.AsBsonRegularExpression.Options, b.AsBsonRegularExpression.Options);
            }
            case 13: return string.CompareOrdinal(a.AsBsonJavaScript.Code, b.AsBsonJavaScript.Code);
            default: return 0;
        }
    }

    /// <summary>Query equality: same comparison bracket and <see cref="Compare"/> == 0 (1 == 1.0 == NumberLong(1)).</summary>
    public static bool ValueEquals(BsonValue a, BsonValue b) => Rank(a) == Rank(b) && Compare(a, b) == 0;

    private static string StringOf(BsonValue v) => v.BsonType == BsonType.Symbol ? v.AsBsonSymbol.Name : v.AsString;

    private static int CompareNumbers(BsonValue a, BsonValue b)
    {
        if (a.BsonType is BsonType.Int32 or BsonType.Int64 && b.BsonType is BsonType.Int32 or BsonType.Int64)
            return a.ToInt64().CompareTo(b.ToInt64());
        if (a.BsonType == BsonType.Decimal128 || b.BsonType == BsonType.Decimal128)
        {
            if (TryDecimal(a, out var x) && TryDecimal(b, out var y)) return x.CompareTo(y);
        }
        var da = ToDouble(a);
        var db = ToDouble(b);
        if (double.IsNaN(da)) return double.IsNaN(db) ? 0 : -1; // NaN sorts below every number
        if (double.IsNaN(db)) return 1;
        return da.CompareTo(db);
    }

    private static bool TryDecimal(BsonValue v, out decimal d)
    {
        try
        {
            d = v.BsonType switch
            {
                BsonType.Decimal128 => Decimal128.ToDecimal(v.AsDecimal128),
                BsonType.Double => double.IsFinite(v.AsDouble) ? (decimal)v.AsDouble : throw new OverflowException(),
                _ => v.ToInt64(),
            };
            return true;
        }
        catch (Exception ex) when (ex is OverflowException or InvalidCastException)
        {
            d = 0;
            return false;
        }
    }

    public static double ToDouble(BsonValue v) => v.BsonType switch
    {
        BsonType.Int32 => v.AsInt32,
        BsonType.Int64 => v.AsInt64,
        BsonType.Double => v.AsDouble,
        BsonType.Decimal128 => Decimal128.ToDouble(v.AsDecimal128),
        _ => double.NaN,
    };

    /// <summary>Values at a dotted path (array elements traversed); <paramref name="expandLeafArrays"/> adds leaf array elements.</summary>
    public static List<BsonValue> PathValues(BsonValue root, string path, bool expandLeafArrays = true)
    {
        var result = new List<BsonValue>();
        Collect(root, path.Split('.'), 0, expandLeafArrays, result);
        return result;
    }

    private static void Collect(BsonValue current, string[] parts, int i, bool expand, List<BsonValue> result)
    {
        if (i == parts.Length)
        {
            result.Add(current);
            if (expand && current is BsonArray leaf) result.AddRange(leaf);
            return;
        }
        switch (current)
        {
            case BsonDocument doc:
                if (doc.TryGetValue(parts[i], out var next)) Collect(next, parts, i + 1, expand, result);
                break;
            case BsonArray arr:
                if (int.TryParse(parts[i], out var index) && index >= 0)
                {
                    if (index < arr.Count) Collect(arr[index], parts, i + 1, expand, result);
                }
                foreach (var el in arr)
                    if (el is BsonDocument) Collect(el, parts, i, expand, result);
                break;
        }
    }

    /// <summary>The value at a dotted path without array traversal (aggregation field path semantics for documents), or null.</summary>
    public static BsonValue? GetPath(BsonDocument doc, string path)
    {
        BsonValue current = doc;
        foreach (var part in path.Split('.'))
        {
            switch (current)
            {
                case BsonDocument d when d.TryGetValue(part, out var v):
                    current = v;
                    break;
                case BsonArray a:
                {
                    // Aggregation semantics: "$items.sku" maps over the array.
                    var mapped = new BsonArray();
                    foreach (var el in a)
                        if (el is BsonDocument ed && ed.TryGetValue(part, out var ev)) mapped.Add(ev);
                    current = mapped;
                    break;
                }
                default:
                    return null;
            }
        }
        return current;
    }

    /// <summary>Sets a dotted path, creating intermediate documents.</summary>
    public static void SetPath(BsonDocument doc, string path, BsonValue value)
    {
        var parts = path.Split('.');
        var current = doc;
        for (var i = 0; i < parts.Length - 1; i++)
        {
            if (current.TryGetValue(parts[i], out var next) && next is BsonDocument nd)
            {
                current = nd;
                continue;
            }
            var created = new BsonDocument();
            current[parts[i]] = created;
            current = created;
        }
        current[parts[^1]] = value;
    }

    /// <summary>Removes a dotted path (no-op when missing).</summary>
    public static void RemovePath(BsonDocument doc, string path)
    {
        var parts = path.Split('.');
        var current = doc;
        for (var i = 0; i < parts.Length - 1; i++)
        {
            if (!current.TryGetValue(parts[i], out var next) || next is not BsonDocument nd) return;
            current = nd;
        }
        current.Remove(parts[^1]);
    }
}
