namespace DbStudio.Providers.Oracle;

/// <summary>Renders Oracle column/argument types the way they are written in DDL.</summary>
public static class OracleTypeText
{
    /// <param name="charUsed">ALL_TAB_COLS.CHAR_USED: 'C' (char semantics) or 'B' (byte).</param>
    /// <param name="schema">Schema being loaded; a user-defined type owned by another schema is qualified.</param>
    public static string Column(string dataType, string? dataTypeOwner, int? dataLength, int? charLength, string? charUsed,
        int? precision, int? scale, string? schema = null)
    {
        var upper = dataType.ToUpperInvariant();
        switch (upper)
        {
            case "VARCHAR2":
            case "CHAR":
                return charUsed == "C" ? $"{dataType}({charLength} CHAR)" : $"{dataType}({dataLength})";
            case "NVARCHAR2":
            case "NCHAR":
                return $"{dataType}({charLength ?? dataLength})";
            case "RAW":
            case "UROWID":
                return dataLength is int l ? $"{dataType}({l})" : dataType;
            case "NUMBER":
                if (precision is null && scale is null) return "NUMBER";
                if (precision is null && scale == 0) return "INTEGER";
                if (precision is null) return $"NUMBER(*,{scale})";
                return scale is null or 0 ? $"NUMBER({precision})" : $"NUMBER({precision},{scale})";
            case "FLOAT":
                return precision is int p && p != 126 ? $"FLOAT({p})" : "FLOAT";
        }
        if (!string.IsNullOrEmpty(dataTypeOwner) && !string.Equals(dataTypeOwner, schema, StringComparison.Ordinal)
            && dataTypeOwner is not ("SYS" or "PUBLIC"))
            return dataTypeOwner + "." + dataType;
        return dataType;
    }

    /// <summary>ALL_ARGUMENTS type: PL/SQL records/collections/objects show their declared type name.</summary>
    public static string Argument(string? dataType, string? typeOwner, string? typeName, string? typeSubname, string? plsType)
    {
        if (!string.IsNullOrEmpty(typeName))
        {
            var name = string.IsNullOrEmpty(typeSubname) ? typeName : typeName + "." + typeSubname;
            return string.IsNullOrEmpty(typeOwner) || typeOwner == "PUBLIC" ? name : typeOwner + "." + name;
        }
        if (!string.IsNullOrEmpty(plsType) && plsType != dataType) return plsType;
        return dataType ?? "";
    }

    /// <summary>ALL_ARGUMENTS.IN_OUT → in | out | inout.</summary>
    public static string Direction(string? inOut) => inOut switch
    {
        "OUT" => "out",
        "IN/OUT" => "inout",
        _ => "in",
    };

    /// <summary>Catalog object type token for an ALL_OBJECTS.OBJECT_TYPE value.</summary>
    public static string? ObjectType(string? oracleType) => oracleType switch
    {
        "TABLE" => Core.Models.ObjectTypes.Table,
        "VIEW" => Core.Models.ObjectTypes.View,
        "MATERIALIZED VIEW" => Core.Models.ObjectTypes.MView,
        "PROCEDURE" => Core.Models.ObjectTypes.Proc,
        "FUNCTION" => Core.Models.ObjectTypes.Func,
        "PACKAGE" => Core.Models.ObjectTypes.Package,
        "SEQUENCE" => Core.Models.ObjectTypes.Sequence,
        "SYNONYM" => Core.Models.ObjectTypes.Synonym,
        "TYPE" => Core.Models.ObjectTypes.Type,
        "TRIGGER" => Core.Models.ObjectTypes.Trigger,
        _ => null,
    };

    /// <summary>DBMS_METADATA object type for a catalog type token.</summary>
    public static string MetadataType(string type) => type switch
    {
        Core.Models.ObjectTypes.Table => "TABLE",
        Core.Models.ObjectTypes.View => "VIEW",
        Core.Models.ObjectTypes.MView => "MATERIALIZED_VIEW",
        Core.Models.ObjectTypes.Proc => "PROCEDURE",
        Core.Models.ObjectTypes.Func or Core.Models.ObjectTypes.TableFunc => "FUNCTION",
        Core.Models.ObjectTypes.Package => "PACKAGE",
        Core.Models.ObjectTypes.Sequence => "SEQUENCE",
        Core.Models.ObjectTypes.Synonym => "SYNONYM",
        Core.Models.ObjectTypes.Type => "TYPE",
        Core.Models.ObjectTypes.Trigger => "TRIGGER",
        _ => throw new ArgumentException($"Unsupported object type '{type}'.", nameof(type)),
    };

    /// <summary>ALL_SOURCE / ALL_ERRORS types making up an object (spec first).</summary>
    public static string[] SourceTypes(string type) => type switch
    {
        Core.Models.ObjectTypes.Proc => ["PROCEDURE"],
        Core.Models.ObjectTypes.Func or Core.Models.ObjectTypes.TableFunc => ["FUNCTION"],
        Core.Models.ObjectTypes.Package => ["PACKAGE", "PACKAGE BODY"],
        Core.Models.ObjectTypes.Type => ["TYPE", "TYPE BODY"],
        Core.Models.ObjectTypes.Trigger => ["TRIGGER"],
        Core.Models.ObjectTypes.View => ["VIEW"],
        _ => [],
    };
}
