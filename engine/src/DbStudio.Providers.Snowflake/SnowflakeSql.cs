using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using DbStudio.Core.Models;
using DbStudio.Core.Sql;

namespace DbStudio.Providers.Snowflake;

/// <summary>
/// Snowflake SQL text helpers: identifier quoting (unquoted names fold to upper case, so a name is written bare only when
/// it is an upper-case plain identifier that is not reserved), string literals (single quotes doubled and backslashes
/// escaped: Snowflake treats <c>\</c> as an escape inside <c>'…'</c>), qualified names and the SHOW commands of the catalog.
/// </summary>
public static partial class SnowflakeSql
{
    /// <summary>Snowflake's reserved keywords (docs "Reserved & limited keywords"): these must be quoted as identifiers.</summary>
    public static readonly IReadOnlySet<string> ReservedWords = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ACCOUNT", "ALL", "ALTER", "AND", "ANY", "AS", "BETWEEN", "BY", "CASE", "CAST", "CHECK", "COLUMN", "CONNECT", "CONNECTION",
        "CONSTRAINT", "CREATE", "CROSS", "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "DATABASE",
        "DELETE", "DISTINCT", "DROP", "ELSE", "EXISTS", "FALSE", "FOLLOWING", "FOR", "FROM", "FULL", "GRANT", "GROUP", "GSCLUSTER",
        "HAVING", "ILIKE", "IN", "INCREMENT", "INNER", "INSERT", "INTERSECT", "INTO", "IS", "ISSUE", "JOIN", "LATERAL", "LEFT", "LIKE",
        "LOCALTIME", "LOCALTIMESTAMP", "MINUS", "NATURAL", "NOT", "NULL", "OF", "ON", "OR", "ORDER", "ORGANIZATION", "QUALIFY",
        "REGEXP", "REVOKE", "RIGHT", "RLIKE", "ROW", "ROWS", "SAMPLE", "SCHEMA", "SELECT", "SET", "SOME", "START", "TABLE",
        "TABLESAMPLE", "THEN", "TO", "TRIGGER", "TRUE", "TRY_CAST", "UNION", "UNIQUE", "UPDATE", "USING", "VALUES", "VIEW", "WHEN",
        "WHENEVER", "WHERE", "WINDOW", "WITH",
    };

    [GeneratedRegex(@"^[A-Z_][A-Z0-9_$]*$", RegexOptions.CultureInvariant)]
    private static partial Regex PlainUpper();

    /// <summary>True when <paramref name="name"/> can be written without quotes and still resolves to itself.</summary>
    public static bool IsPlain(string name) => PlainUpper().IsMatch(name) && !ReservedWords.Contains(name);

    /// <summary>The identifier as written in generated SQL: bare when plain, else <c>"…"</c> with quotes doubled.</summary>
    public static string Quote(string name) => IsPlain(name) ? name : AlwaysQuote(name);

    /// <summary>Always double-quoted (the SHOW / GET_DDL / USE commands of the engine use this form).</summary>
    public static string AlwaysQuote(string name) => "\"" + name.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";

    /// <summary><c>db.schema.name</c> with the parts that are given, each through <see cref="Quote"/>.</summary>
    public static string Qualify(string? database, string? schema, string name)
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrEmpty(database)) sb.Append(Quote(database)).Append('.');
        if (!string.IsNullOrEmpty(schema)) sb.Append(Quote(schema)).Append('.');
        return sb.Append(Quote(name)).ToString();
    }

    /// <summary>Fully quoted <c>"DB"."SCHEMA"</c> (or <c>"SCHEMA"</c>) for SHOW … IN SCHEMA.</summary>
    public static string SchemaPath(string? database, string schema) =>
        string.IsNullOrEmpty(database) ? AlwaysQuote(schema) : AlwaysQuote(database) + "." + AlwaysQuote(schema);

    /// <summary>Fully quoted <c>"DB"."SCHEMA"."NAME"</c>.</summary>
    public static string ObjectPath(string? database, string? schema, string name)
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrEmpty(database)) sb.Append(AlwaysQuote(database)).Append('.');
        if (!string.IsNullOrEmpty(schema)) sb.Append(AlwaysQuote(schema)).Append('.');
        return sb.Append(AlwaysQuote(name)).ToString();
    }

    /// <summary>A string literal: <c>'it''s'</c>, backslashes doubled.</summary>
    public static string Literal(string value) =>
        "'" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("'", "''", StringComparison.Ordinal) + "'";

    /// <summary>A LIKE pattern for SHOW … LIKE that matches exactly <paramref name="name"/> (SHOW LIKE is case-insensitive; _ and % escaped).</summary>
    public static string ShowLikeExact(string name) =>
        Literal(name.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal));

    public static string Int(long value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// Folds a user-typed name to its stored form: <c>"Mixed"</c> keeps its case (quotes removed), anything else is
    /// upper-cased (unquoted identifiers resolve case-insensitively as upper case).
    /// </summary>
    public static string Normalize(string name)
    {
        var n = name.Trim();
        if (n.Length >= 2 && n[0] == '"' && n[^1] == '"') return n[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal);
        return n.ToUpperInvariant();
    }

    // ------------------------------------------------------------------ catalog commands (no warehouse needed)

    public const string ShowDatabases = "SHOW DATABASES";
    public static string ShowSchemas(string database) => $"SHOW SCHEMAS IN DATABASE {AlwaysQuote(database)}";
    public static string ShowTables(string? database, string schema) => $"SHOW TABLES IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowViews(string? database, string schema) => $"SHOW VIEWS IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowColumns(string? database, string schema) => $"SHOW COLUMNS IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowPrimaryKeys(string? database, string schema) => $"SHOW PRIMARY KEYS IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowImportedKeys(string? database, string schema) => $"SHOW IMPORTED KEYS IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowUniqueKeys(string? database, string schema) => $"SHOW UNIQUE KEYS IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowProcedures(string? database, string schema) => $"SHOW USER PROCEDURES IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowFunctions(string? database, string schema) => $"SHOW USER FUNCTIONS IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowSequences(string? database, string schema) => $"SHOW SEQUENCES IN SCHEMA {SchemaPath(database, schema)}";

    public static string ShowTableLike(string? database, string schema, string name) => $"SHOW TABLES LIKE {ShowLikeExact(name)} IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowViewLike(string? database, string schema, string name) => $"SHOW VIEWS LIKE {ShowLikeExact(name)} IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowProcedureLike(string? database, string schema, string name) => $"SHOW USER PROCEDURES LIKE {ShowLikeExact(name)} IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowFunctionLike(string? database, string schema, string name) => $"SHOW USER FUNCTIONS LIKE {ShowLikeExact(name)} IN SCHEMA {SchemaPath(database, schema)}";
    public static string ShowSequenceLike(string? database, string schema, string name) => $"SHOW SEQUENCES LIKE {ShowLikeExact(name)} IN SCHEMA {SchemaPath(database, schema)}";
    public static string DescribeTable(string? database, string schema, string name) => $"DESCRIBE TABLE {ObjectPath(database, schema, name)}";
    public static string DescribeView(string? database, string schema, string name) => $"DESCRIBE VIEW {ObjectPath(database, schema, name)}";
    public static string ShowPrimaryKeysIn(string? database, string schema, string table) => $"SHOW PRIMARY KEYS IN TABLE {ObjectPath(database, schema, table)}";
    public static string ShowImportedKeysIn(string? database, string schema, string table) => $"SHOW IMPORTED KEYS IN TABLE {ObjectPath(database, schema, table)}";
    public static string ShowExportedKeysIn(string? database, string schema, string table) => $"SHOW EXPORTED KEYS IN TABLE {ObjectPath(database, schema, table)}";
    public static string ShowUniqueKeysIn(string? database, string schema, string table) => $"SHOW UNIQUE KEYS IN TABLE {ObjectPath(database, schema, table)}";

    /// <summary><c>DESCRIBE PROCEDURE "DB"."S"."P"(NUMBER, VARCHAR)</c> (routines are overloadable: the argument types are part of the name).</summary>
    public static string DescribeRoutine(bool procedure, string? database, string schema, string name, IReadOnlyList<string> argTypes) =>
        $"DESCRIBE {(procedure ? "PROCEDURE" : "FUNCTION")} {ObjectPath(database, schema, name)}({string.Join(", ", argTypes)})";

    /// <summary><c>SELECT GET_DDL('TABLE', '"DB"."S"."T"', TRUE)</c>; routines carry their argument types in the name.</summary>
    public static string GetDdl(string objectType, string? database, string? schema, string name, IReadOnlyList<string>? argTypes = null)
    {
        var path = ObjectPath(database, schema, name);
        if (argTypes is not null) path += "(" + string.Join(", ", argTypes) + ")";
        return $"SELECT GET_DDL({Literal(objectType)}, {Literal(path)}, TRUE) AS DDL";
    }

    public const string ServerInfo =
        "SELECT CURRENT_VERSION() AS VERSION, CURRENT_ACCOUNT() AS ACCOUNT, CURRENT_REGION() AS REGION, CURRENT_USER() AS USER_NAME, " +
        "CURRENT_DATABASE() AS DATABASE_NAME, CURRENT_SCHEMA() AS SCHEMA_NAME, CURRENT_WAREHOUSE() AS WAREHOUSE_NAME, CURRENT_ROLE() AS ROLE_NAME";

    public const string SessionContext =
        "SELECT CURRENT_WAREHOUSE() AS WAREHOUSE_NAME, CURRENT_ROLE() AS ROLE_NAME, CURRENT_DATABASE() AS DATABASE_NAME, " +
        "CURRENT_SCHEMA() AS SCHEMA_NAME, CURRENT_SECONDARY_ROLES() AS SECONDARY_ROLES, CURRENT_SESSION() AS SESSION_ID";

    /// <summary>
    /// The routine signature of a SHOW PROCEDURES / FUNCTIONS <c>arguments</c> cell: <c>"GET_TOTAL(NUMBER, [VARCHAR]) RETURN NUMBER(38,0)"</c>
    /// → (["NUMBER", "VARCHAR"], "NUMBER(38,0)"). Optional arguments (brackets) count as arguments; DEFAULT markers are dropped.
    /// </summary>
    public static (IReadOnlyList<string> ArgTypes, string? Returns) ParseArguments(string? arguments)
    {
        if (string.IsNullOrWhiteSpace(arguments)) return ([], null);
        var s = arguments.Trim();
        var open = s.IndexOf('(');
        if (open < 0) return ([], null);
        var depth = 0;
        var close = -1;
        for (var i = open; i < s.Length; i++)
        {
            if (s[i] == '(') depth++;
            else if (s[i] == ')' && --depth == 0) { close = i; break; }
        }
        if (close < 0) return ([], null);
        var inner = s[(open + 1)..close];
        var args = SplitTopLevel(inner).Select(a => a.Trim().Trim('[', ']').Trim())
            .Select(a => a.EndsWith(" DEFAULT", StringComparison.OrdinalIgnoreCase) ? a[..^8].Trim() : a)
            .Where(a => a.Length > 0).ToList();
        var rest = s[(close + 1)..].Trim();
        string? returns = null;
        if (rest.StartsWith("RETURN", StringComparison.OrdinalIgnoreCase)) returns = rest[6..].Trim();
        return (args, string.IsNullOrEmpty(returns) ? null : returns);
    }

    /// <summary>Splits on commas outside parentheses: "NUMBER(10, 2), VARCHAR" → ["NUMBER(10, 2)", "VARCHAR"].</summary>
    public static List<string> SplitTopLevel(string text)
    {
        var list = new List<string>();
        var depth = 0;
        var last = 0;
        for (var i = 0; i < text.Length; i++)
        {
            switch (text[i])
            {
                case '(': depth++; break;
                case ')': depth--; break;
                case ',' when depth == 0:
                    list.Add(text[last..i]);
                    last = i + 1;
                    break;
            }
        }
        if (last < text.Length || list.Count > 0) list.Add(text[last..]);
        return list.Where(x => x.Trim().Length > 0).ToList();
    }

    /// <summary>
    /// <c>(ORDER_ID NUMBER, NOTE VARCHAR DEFAULT 'x')</c> (DESCRIBE PROCEDURE "signature") → parameters with names.
    /// </summary>
    public static List<ParamInfo> ParseSignature(string? signature)
    {
        var list = new List<ParamInfo>();
        if (string.IsNullOrWhiteSpace(signature)) return list;
        var s = signature.Trim();
        if (s.StartsWith('(') && s.EndsWith(')')) s = s[1..^1];
        foreach (var part in SplitTopLevel(s))
        {
            var p = part.Trim();
            var hasDefault = false;
            var def = p.IndexOf(" DEFAULT ", StringComparison.OrdinalIgnoreCase);
            if (def > 0) { hasDefault = true; p = p[..def].Trim(); }
            var space = p.IndexOf(' ');
            if (space <= 0) { list.Add(new ParamInfo("", p, "in", hasDefault)); continue; }
            list.Add(new ParamInfo(p[..space].Trim('"'), p[(space + 1)..].Trim(), "in", hasDefault));
        }
        return list;
    }

    /// <summary>One statement of a batch: its text (no trailing semicolon) and where it starts.</summary>
    public readonly record struct Statement(string Text, int Start, int Line, int Col);

    /// <summary>
    /// Statements of a batch (Snowflake lexical rules: <c>$$</c> bodies, backslash escapes). Snowflake Scripting blocks
    /// outside <c>$$</c> (<c>DECLARE … BEGIN … END;</c>, <c>BEGIN … END;</c>) stay one statement: BEGIN, IF, FOR, WHILE,
    /// REPEAT, LOOP and CASE open a level, END closes it (END IF / END FOR / … close what they name). A plain
    /// <c>BEGIN [TRANSACTION|WORK|NAME x];</c> is a transaction start, not a block.
    /// </summary>
    public static List<Statement> SplitStatements(string sql)
    {
        var tokens = SqlTokenizer.Tokenize(sql, Dialect.Snowflake);
        var list = new List<Statement>();
        var start = -1;
        var block = false;
        var depth = 0;
        var paren = 0;
        var declares = 0;
        for (var k = 0; k < tokens.Count; k++)
        {
            var t = tokens[k];
            if (start < 0)
            {
                if (t.IsPunct(';')) continue;
                start = k;
                block = StartsScriptBlock(tokens, k);
                depth = 0;
                paren = 0;
                declares = 0;
            }
            if (t.IsPunct('(')) paren++;
            else if (t.IsPunct(')')) paren = Math.Max(0, paren - 1);
            else if (block && t.Kind == SqlTokenKind.Word)
            {
                var u = t.Upper;
                var prevEnd = k > 0 && tokens[k - 1].IsWord("END");
                var cursorFor = u == "FOR" && k > 0 && tokens[k - 1].IsWord("CURSOR");
                if (u == "DECLARE")
                {
                    // DECLARE … BEGIN … END is one level: the BEGIN after a DECLARE section does not open another.
                    depth++;
                    declares++;
                }
                else if (u == "BEGIN" && declares > 0 && !prevEnd)
                {
                    declares--;
                }
                else if (!prevEnd && !cursorFor && (u is "BEGIN" or "CASE" or "FOR" or "WHILE" or "REPEAT" or "LOOP"
                                 || (u == "IF" && !(k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "EXISTS" or "NOT"))))
                    depth++;
                else if (u == "END" && depth > 0)
                {
                    depth--;
                    if (k + 1 < tokens.Count && tokens[k + 1].Kind == SqlTokenKind.Word && tokens[k + 1].Upper is "IF" or "FOR" or "WHILE" or "REPEAT" or "LOOP" or "CASE")
                        k++;
                }
            }
            if (t.IsPunct(';') && paren == 0 && depth == 0)
            {
                Add(k - 1);
                start = -1;
            }
        }
        if (start >= 0) Add(tokens.Count - 1);
        return list;

        void Add(int lastToken)
        {
            if (lastToken < start) return;
            var first = tokens[start];
            var text = sql[first.Start..tokens[lastToken].End];
            if (text.Trim().Length > 0) list.Add(new Statement(text, first.Start, first.Line, first.Col));
        }
    }

    /// <summary>DECLARE …, or BEGIN followed by a statement (not <c>BEGIN;</c> / <c>BEGIN TRANSACTION</c> / <c>WORK</c> / <c>NAME</c>).</summary>
    public static bool StartsScriptBlock(IReadOnlyList<SqlToken> tokens, int k)
    {
        var t = tokens[k];
        if (t.IsWord("DECLARE")) return true;
        if (!t.IsWord("BEGIN")) return false;
        if (k + 1 >= tokens.Count) return false;
        var next = tokens[k + 1];
        return !(next.IsPunct(';') || (next.Kind == SqlTokenKind.Word && next.Upper is "TRANSACTION" or "WORK" or "NAME"));
    }
}
