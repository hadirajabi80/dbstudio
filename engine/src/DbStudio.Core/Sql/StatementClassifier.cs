using DbStudio.Core.Models;

namespace DbStudio.Core.Sql;

public enum StatementCategory
{
    Unknown,
    /// <summary>SELECT / WITH ... SELECT / VALUES / EXPLAIN / read-only PRAGMA.</summary>
    Query,
    /// <summary>INSERT / UPDATE / DELETE / MERGE / REPLACE.</summary>
    Dml,
    /// <summary>CREATE / ALTER / DROP / TRUNCATE / RENAME / COMMENT / ATTACH / DETACH / SELECT INTO.</summary>
    Ddl,
    /// <summary>BEGIN TRAN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE.</summary>
    Transaction,
    /// <summary>SET / USE / DECLARE (T-SQL) / PRINT / WAITFOR / PRAGMA with a value.</summary>
    Session,
    /// <summary>PL/SQL anonymous block, T-SQL control flow (IF/WHILE/BEGIN...END/TRY).</summary>
    Block,
    /// <summary>EXEC / CALL / GRANT / REVOKE / VACUUM / ANALYZE ...</summary>
    Other,
}

/// <summary>How far a DDL statement's effect on the catalog reaches.</summary>
public enum DdlScope
{
    /// <summary>One object in one schema (or the default schema when unqualified).</summary>
    Object,
    /// <summary>The list of schemas / attached databases changes (CREATE SCHEMA, DROP USER, ATTACH ...).</summary>
    Database,
    /// <summary>Temporary object: no catalog change.</summary>
    Temporary,
}

/// <param name="Action">CREATE | ALTER | DROP | RENAME | COMMENT | ATTACH | DETACH | SELECT INTO.</param>
/// <param name="ObjectType">table, view, index, proc, func, trigger, sequence, synonym, package, type, mview, schema, database, user, or null when unknown.</param>
/// <param name="Database">Explicit database qualifier (T-SQL three-part names).</param>
/// <param name="Schema">Explicit schema qualifier (SQLite: attached database name).</param>
public sealed record DdlTarget(string Action, string? ObjectType, string? Database, string? Schema, string? Name, DdlScope Scope);

public sealed record StatementClassification(StatementCategory Category, string Kind, bool HasWhere, DdlTarget? Ddl, int StartOffset)
{
    /// <summary>DELETE/UPDATE without WHERE, DROP, TRUNCATE.</summary>
    public bool IsDestructive =>
        (Category == StatementCategory.Dml && Kind is "DELETE" or "UPDATE" && !HasWhere)
        || Kind.StartsWith("DROP", StringComparison.Ordinal)
        || Kind.StartsWith("TRUNCATE", StringComparison.Ordinal);
}

public sealed class BatchClassification(IReadOnlyList<StatementClassification> statements, bool containsWriteKeyword)
{
    public IReadOnlyList<StatementClassification> Statements { get; } = statements;

    /// <summary>True when every statement only reads (queries, session SET/USE/DECLARE, transaction control) and no
    /// data-changing keyword appears anywhere in the batch. Empty batches count as queries.</summary>
    public bool IsQueryOnly { get; } = !containsWriteKeyword && statements.All(s =>
        s.Category is StatementCategory.Query or StatementCategory.Session or StatementCategory.Transaction);

    /// <summary>True when a statement sets a savepoint (SAVEPOINT x / T-SQL SAVE TRAN[SACTION] x). A savepoint only means
    /// something inside a transaction, so manual mode begins the engine transaction for it (see AdoSessionBase).</summary>
    public bool HasSavepoint => Statements.Any(s => s.Category == StatementCategory.Transaction && s.Kind is "SAVEPOINT" or "SAVE TRANSACTION");

    public bool HasDml => Statements.Any(s => s.Category == StatementCategory.Dml || s.Kind == "SELECT INTO");
    public bool HasDdl => Statements.Any(s => s.Ddl is not null);
    public bool IsDestructive => Statements.Any(s => s.IsDestructive);

    /// <summary>Kind of the first DML statement, else of the first statement (e.g. "UPDATE", "CREATE TABLE").</summary>
    public string? PrimaryKind =>
        (Statements.FirstOrDefault(s => s.Category == StatementCategory.Dml) ?? Statements.FirstOrDefault())?.Kind;

    public IEnumerable<DdlTarget> DdlTargets => Statements.Where(s => s.Ddl is not null).Select(s => s.Ddl!);
}

/// <summary>
/// Dialect-aware statement classifier over <see cref="SqlTokenizer"/> tokens. Used for the read-only guard,
/// rows-affected statement kinds, history labels and catalog invalidation after DDL (docs/PLAN.md 2.7).
/// Heuristic by design: it looks at leading keywords and a handful of structural tokens, never a full parse.
/// </summary>
public static class StatementClassifier
{
    /// <summary>Keywords that, anywhere in a batch outside strings/comments/quoted names, make it a non-query.</summary>
    private static readonly HashSet<string> WriteKeywords = new(StringComparer.OrdinalIgnoreCase)
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "DENY",
        "EXEC", "EXECUTE", "CALL", "UPSERT", "ATTACH", "DETACH", "VACUUM", "REINDEX", "BACKUP", "RESTORE", "DBCC",
        "BULK", "KILL", "RENAME", "SHUTDOWN", "RECONFIGURE",
    };

    private static readonly HashSet<string> ReadOnlyPragmas = new(StringComparer.OrdinalIgnoreCase)
    {
        "table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list",
        "database_list", "function_list", "collation_list", "module_list", "pragma_list", "compile_options",
        "integrity_check", "quick_check", "foreign_key_check", "stats",
    };

    public static BatchClassification Classify(string sql, Dialect dialect)
    {
        var tokens = SqlTokenizer.Tokenize(sql, dialect);
        var statements = SqlTokenizer.SplitStatements(tokens, dialect);
        var list = new List<StatementClassification>(statements.Count);
        foreach (var st in statements)
        {
            list.Add(ClassifyStatement(st, dialect));
            if (dialect == Dialect.TSql) AddEmbeddedTsqlDdl(st, list);
        }
        return new BatchClassification(list, ContainsWriteKeyword(tokens, statements, dialect));
    }

    public static bool IsQueryOnly(string sql, Dialect dialect) => Classify(sql, dialect).IsQueryOnly;

    private static bool ContainsWriteKeyword(List<SqlToken> tokens, List<List<SqlToken>> statements, Dialect dialect)
    {
        foreach (var t in tokens)
        {
            if (t.Kind == SqlTokenKind.Word && WriteKeywords.Contains(t.Value)) return true;
        }
        foreach (var st in statements)
        {
            if (st.Count == 0) continue;
            var head = st[0];
            // REPLACE is a common function name; only a statement head (SQLite REPLACE INTO) writes.
            if (head.IsWord("REPLACE")) return true;
            if (dialect is Dialect.TSql or Dialect.PgSql && HasSelectInto(st)) return true;
        }
        return false;
    }

    private static StatementClassification ClassifyStatement(List<SqlToken> t, Dialect dialect)
    {
        // Skip leading parentheses: "(SELECT ...) UNION ..."
        var i = 0;
        while (i < t.Count && t[i].IsPunct('(')) i++;
        if (i >= t.Count) return new(StatementCategory.Unknown, "", false, null, t.Count > 0 ? t[0].Start : 0);
        var start = t[0].Start;
        var head = t[i];
        if (head.Kind != SqlTokenKind.Word) return new(StatementCategory.Unknown, "", false, null, start);

        var u = head.Upper;
        var hasWhere = HasDepth0Word(t, i, "WHERE");
        // Batch 3: dialect-specific heads first (null = fall through to the shared switch below).
        var special = dialect switch
        {
            Dialect.MySql => ClassifyMySql(t, i, u, hasWhere, start),
            Dialect.ClickHouse => ClassifyClickHouse(t, i, u, hasWhere, start),
            Dialect.Snowflake => ClassifySnowflake(t, i, u, hasWhere, start),
            Dialect.Cql => ClassifyCql(t, i, u, hasWhere, start),
            _ => null,
        };
        if (special is not null) return special;
        switch (u)
        {
            case "SELECT":
                if (dialect is Dialect.TSql or Dialect.PgSql && HasSelectInto(t))
                    return new(StatementCategory.Ddl, "SELECT INTO", hasWhere, SelectIntoTarget(t, dialect), start);
                return new(StatementCategory.Query, "SELECT", hasWhere, null, start);
            case "VALUES":
            case "EXPLAIN":
            case "TABLE" when dialect is Dialect.Sqlite or Dialect.PgSql:
                return new(StatementCategory.Query, u, hasWhere, null, start);
            case "WITH":
                {
                    var dml = FirstDepth0Word(t, i + 1, "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE");
                    return dml is null
                        ? new(StatementCategory.Query, "SELECT", hasWhere, null, start)
                        : new(StatementCategory.Dml, dml, hasWhere, null, start);
                }
            case "INSERT":
            case "UPDATE":
            case "DELETE":
            case "MERGE":
            case "UPSERT":
                return new(StatementCategory.Dml, u, hasWhere, null, start);
            case "REPLACE":
                return new(StatementCategory.Dml, "REPLACE", hasWhere, null, start);
            case "CREATE":
            case "ALTER":
            case "DROP":
                return ClassifyDdl(t, i, u, dialect, start);
            case "TRUNCATE":
                return new(StatementCategory.Ddl, "TRUNCATE TABLE", false, null, start);
            case "RENAME": // Oracle: RENAME a TO b
                return new(StatementCategory.Ddl, "RENAME", false,
                    new DdlTarget("RENAME", ObjectTypes.Table, null, null, NameAfter(t, i + 1, out _)?.LastOrDefault(), DdlScope.Object), start);
            case "COMMENT": // Oracle: COMMENT ON TABLE/COLUMN x IS '...'
                {
                    var parts = i + 3 < t.Count ? NameAfter(t, i + 3, out _) : null;
                    var isColumn = i + 2 < t.Count && t[i + 2].IsWord("COLUMN");
                    if (isColumn && parts is { Count: > 1 }) parts = parts.Take(parts.Count - 1).ToList();
                    var (db, schema, name) = SplitName(parts, dialect);
                    return new(StatementCategory.Ddl, "COMMENT", false,
                        new DdlTarget("COMMENT", ObjectTypes.Table, db, schema, name, DdlScope.Object), start);
                }
            case "ATTACH":
            case "DETACH":
                return new(StatementCategory.Ddl, u, false, new DdlTarget(u, "database", null, null, null, DdlScope.Database), start);
            case "BEGIN":
                if (dialect == Dialect.PlSql) return new(StatementCategory.Block, "BEGIN", hasWhere, null, start);
                if (dialect is Dialect.Sqlite or Dialect.PgSql) return new(StatementCategory.Transaction, "BEGIN", false, null, start);
                // T-SQL: BEGIN TRAN[SACTION] / BEGIN DISTRIBUTED TRAN vs BEGIN ... END / BEGIN TRY
                if (i + 1 < t.Count && t[i + 1].Kind == SqlTokenKind.Word && t[i + 1].Upper is "TRAN" or "TRANSACTION" or "DISTRIBUTED")
                    return new(StatementCategory.Transaction, "BEGIN TRANSACTION", false, null, start);
                return new(StatementCategory.Block, "BEGIN", hasWhere, null, start);
            case "COMMIT":
            case "ROLLBACK":
            case "SAVEPOINT":
            case "RELEASE":
                return new(StatementCategory.Transaction, u, false, null, start);
            case "END" when dialect is Dialect.Sqlite or Dialect.PgSql:
                return new(StatementCategory.Transaction, "COMMIT", false, null, start);
            case "SAVE" when dialect == Dialect.TSql:
                return new(StatementCategory.Transaction, "SAVE TRANSACTION", false, null, start);
            // PostgreSQL (docs/PLAN-PG.md 1.1): function bodies are dollar-quoted strings, so these heads are reliable.
            case "START" when dialect == Dialect.PgSql:
                return new(StatementCategory.Transaction, "BEGIN", false, null, start);
            case "ABORT" when dialect == Dialect.PgSql:
                return new(StatementCategory.Transaction, "ROLLBACK", false, null, start);
            case "DO" when dialect == Dialect.PgSql:
                return new(StatementCategory.Block, "DO", hasWhere, null, start);
            case "COPY" when dialect == Dialect.PgSql:
                return new(StatementCategory.Dml, "COPY", false, null, start);
            case "SHOW" or "RESET" or "DISCARD" when dialect == Dialect.PgSql:
                return new(StatementCategory.Session, u, false, null, start);
            case "DECLARE":
                return dialect == Dialect.PlSql
                    ? new(StatementCategory.Block, "DECLARE", hasWhere, null, start)
                    : new(StatementCategory.Session, "DECLARE", hasWhere, null, start);
            case "SET":
            case "USE":
            case "PRINT":
            case "WAITFOR":
            case "RAISERROR":
            case "THROW":
                return new(StatementCategory.Session, u, false, null, start);
            case "PRAGMA":
                return ClassifyPragma(t, i);
            case "IF":
            case "WHILE":
            case "TRY":
                return new(StatementCategory.Block, u, hasWhere, null, start);
            case "EXEC":
            case "EXECUTE":
                {
                    var target = i + 1 < t.Count ? NameAfter(t, i + 1, out _) : null;
                    var proc = target?.LastOrDefault();
                    if (dialect == Dialect.TSql && proc is not null && proc.Equals("sp_rename", StringComparison.OrdinalIgnoreCase))
                        return new(StatementCategory.Ddl, "RENAME", false, new DdlTarget("RENAME", null, null, null, null, DdlScope.Object), start);
                    return new(StatementCategory.Other, "EXEC", false, null, start);
                }
            default:
                return new(StatementCategory.Other, u, hasWhere, null, start);
        }
    }

    // Batch 3 per-dialect heads (t = statement tokens, i = index of the head word, u = its upper-case value). Return null
    // to use the shared switch. Each WP edits only its own block.

    // WP-MY begin (MySQL/MariaDB: SHOW, DESCRIBE/DESC, START TRANSACTION, CALL, HANDLER, LOCK/UNLOCK TABLES, …)
    private static StatementClassification? ClassifyMySql(List<SqlToken> t, int i, string u, bool hasWhere, int start)
    {
        string? Next(int k) => i + k < t.Count && t[i + k].Kind == SqlTokenKind.Word ? t[i + k].Upper : null;
        switch (u)
        {
            case "SHOW" or "DESCRIBE" or "DESC" or "HELP" or "HANDLER" or "CHECKSUM":
                return new(StatementCategory.Query, u is "DESC" ? "DESCRIBE" : u, false, null, start);
            case "EXPLAIN" or "ANALYZE":
            {
                // EXPLAIN ANALYZE / MariaDB ANALYZE <stmt> execute the statement; ANALYZE TABLE writes statistics.
                if (u == "ANALYZE" && Next(1) is "TABLE" or "NO_WRITE_TO_BINLOG" or "LOCAL") return new(StatementCategory.Other, "ANALYZE TABLE", false, null, start);
                var dml = FirstDepth0Word(t, i + 1, "INSERT", "UPDATE", "DELETE", "REPLACE");
                return dml is null || (u == "EXPLAIN" && Next(1) != "ANALYZE")
                    ? new(StatementCategory.Query, "EXPLAIN", hasWhere, null, start)
                    : new(StatementCategory.Dml, dml, hasWhere, null, start);
            }
            case "START" when Next(1) == "TRANSACTION":
                return new(StatementCategory.Transaction, "BEGIN", false, null, start);
            case "BEGIN":
                return Next(1) == "NOT"
                    ? new(StatementCategory.Block, "BEGIN", hasWhere, null, start)
                    : new(StatementCategory.Transaction, "BEGIN", false, null, start);
            case "ROLLBACK" when FirstDepth0Word(t, i + 1, "TO") is not null:
                return new(StatementCategory.Transaction, "ROLLBACK TO SAVEPOINT", false, null, start);
            case "XA":
                return new(StatementCategory.Transaction, "XA", false, null, start);
            case "CALL":
                return new(StatementCategory.Other, "CALL", false, null, start);
            case "LOCK" or "UNLOCK":
                return new(StatementCategory.Session, u + " " + (Next(1) ?? "TABLES"), false, null, start);
            case "LOAD":
                return new(StatementCategory.Dml, "LOAD " + (Next(1) ?? "DATA"), false, null, start);
            case "PREPARE" or "DEALLOCATE":
                return new(StatementCategory.Session, u, false, null, start);
            case "TABLE":
                return new(StatementCategory.Query, "TABLE", false, null, start);
            case "DO" or "KILL" or "FLUSH" or "RESET" or "PURGE" or "OPTIMIZE" or "REPAIR" or "CHECK" or "INSTALL" or "UNINSTALL"
                or "SIGNAL" or "RESIGNAL" or "CACHE" or "BINLOG" or "CHANGE" or "SHUTDOWN" or "RESTART":
                return new(StatementCategory.Other, u is "OPTIMIZE" or "REPAIR" or "CHECK" ? u + " TABLE" : u, false, null, start);
            case "RENAME":
            {
                // RENAME TABLE a TO b [, c TO d] / RENAME USER …
                if (Next(1) is "USER") return new(StatementCategory.Other, "RENAME USER", false, null, start);
                var parts = Next(1) == "TABLE" ? NameAfter(t, i + 2, out _) : null;
                var (_, schema, name) = SplitName(parts, Dialect.MySql);
                return new(StatementCategory.Ddl, "RENAME TABLE", false, new DdlTarget("RENAME", ObjectTypes.Table, null, schema, name, DdlScope.Object), start);
            }
            case "CREATE" or "ALTER" or "DROP":
            {
                // MySQL modifiers the shared DDL parser does not know: DEFINER = user@host, ALGORITHM = x, SQL SECURITY x,
                // AGGREGATE (MariaDB); events are routines of the catalog (proc).
                var filtered = new List<SqlToken>(t.Count) { };
                filtered.AddRange(t.Take(i + 1));
                var changed = false;
                var k = i + 1;
                while (k < t.Count)
                {
                    var w = t[k].Kind == SqlTokenKind.Word ? t[k].Upper : null;
                    if (w is "OR" or "REPLACE") { filtered.Add(t[k]); k++; continue; }
                    if (w is "DEFINER" or "ALGORITHM" && k + 1 < t.Count && t[k + 1].Kind == SqlTokenKind.Operator && t[k + 1].Value == "=")
                    {
                        k += 2;
                        if (k < t.Count && t[k].IsWord("CURRENT_USER") && k + 2 < t.Count && t[k + 1].IsPunct('(') && t[k + 2].IsPunct(')')) k += 2;
                        k++;
                        // user@host: '@' (operator) and the host
                        if (k + 1 < t.Count && t[k].Kind == SqlTokenKind.Operator && t[k].Value == "@") k += 2;
                        else if (k < t.Count && t[k].Kind == SqlTokenKind.Parameter && t[k].Value.StartsWith('@')) k++;
                        changed = true;
                        continue;
                    }
                    if (w is "SQL" && k + 2 < t.Count && t[k + 1].IsWord("SECURITY")) { k += 3; changed = true; continue; }
                    if (w is "AGGREGATE") { k++; changed = true; continue; }
                    break;
                }
                if (k < t.Count && t[k].IsWord("EVENT"))
                {
                    var j = k + 1;
                    if (j < t.Count && t[j].IsWord("IF"))
                    {
                        j++;
                        if (j < t.Count && t[j].IsWord("NOT")) j++;
                        if (j < t.Count && t[j].IsWord("EXISTS")) j++;
                    }
                    var (_, schema, name) = SplitName(NameAfter(t, j, out _), Dialect.MySql);
                    return new(StatementCategory.Ddl, u + " EVENT", false, new DdlTarget(u, ObjectTypes.Proc, null, schema, name, DdlScope.Object), start);
                }
                if (!changed) return null;
                filtered.AddRange(t.Skip(k));
                return ClassifyDdl(filtered, i, u, Dialect.MySql, start);
            }
            default:
                return null;
        }
    }
    // WP-MY end

    // WP-CH begin (ClickHouse: SHOW, DESCRIBE, EXISTS, OPTIMIZE, SYSTEM, KILL, ALTER … UPDATE/DELETE mutations, …)
    private static StatementClassification? ClassifyClickHouse(List<SqlToken> t, int i, string u, bool hasWhere, int start)
    {
        string? Next(int k) => i + k < t.Count && t[i + k].Kind == SqlTokenKind.Word ? t[i + k].Upper : null;
        DdlTarget? ObjectAt(string action, string objectType, int nameAt)
        {
            if (nameAt < t.Count && t[nameAt].IsWord("IF"))
            {
                nameAt++;
                if (nameAt < t.Count && t[nameAt].IsWord("NOT")) nameAt++;
                if (nameAt < t.Count && t[nameAt].IsWord("EXISTS")) nameAt++;
            }
            var (db, schema, name) = SplitName(NameAfter(t, nameAt, out _), Dialect.ClickHouse);
            return new DdlTarget(action, objectType, db, schema, name, DdlScope.Object);
        }
        switch (u)
        {
            case "SHOW" or "DESCRIBE" or "DESC" or "EXISTS" or "WATCH":
                return new(StatementCategory.Query, u, hasWhere, null, start);
            case "OPTIMIZE" or "SYSTEM" or "KILL" or "CHECK":
                return new(StatementCategory.Other, u, hasWhere, null, start);
            case "ALTER" when Next(1) == "TABLE":
            {
                // ALTER TABLE t UPDATE … / DELETE … are mutations (DML); DROP/DETACH PARTITION|PART deletes data.
                var depth = 0;
                for (var k = i + 2; k < t.Count; k++)
                {
                    if (t[k].IsPunct('(')) depth++;
                    else if (t[k].IsPunct(')')) depth--;
                    if (depth != 0 || t[k].Kind != SqlTokenKind.Word) continue;
                    var w = t[k].Upper;
                    if (w is "UPDATE" or "DELETE" && k > i + 2)
                        return new(StatementCategory.Dml, w, HasDepth0Word(t, k, "WHERE") && !WhereIsTrivial(t, k), null, start);
                    if (w is "DROP" or "DETACH" && k + 1 < t.Count && t[k + 1].Kind == SqlTokenKind.Word && t[k + 1].Upper is "PARTITION" or "PART")
                        return new(StatementCategory.Ddl, $"DROP {t[k + 1].Upper}", false, ObjectAt("ALTER", ObjectTypes.Table, i + 2), start);
                }
                return null;
            }
            case "CREATE" or "DROP" or "ATTACH" or "DETACH" or "UNDROP" or "ALTER" or "EXCHANGE" or "RENAME":
            {
                var j = 1;
                while (Next(j) is "OR" or "REPLACE" or "TEMPORARY") j++;
                var what = Next(j);
                if (what == "DICTIONARY" || what == "DICTIONARIES")
                    return new(StatementCategory.Ddl, $"{u} DICTIONARY", false, ObjectAt(u, ObjectTypes.Type, i + j + 1), start);
                if (u is "ATTACH" or "DETACH" or "UNDROP" && what is "TABLE" or "VIEW")
                    return new(StatementCategory.Ddl, $"{u} {what}", false, ObjectAt(u, what == "VIEW" ? ObjectTypes.View : ObjectTypes.Table, i + j + 1), start);
                if (u is "ATTACH" or "DETACH" && what == "DATABASE")
                    return new(StatementCategory.Ddl, $"{u} DATABASE", false, new DdlTarget(u, "database", null, null, null, DdlScope.Database), start);
                if (u is "RENAME" or "EXCHANGE" && what is "TABLE" or "TABLES" or "DATABASE")
                    return new(StatementCategory.Ddl, $"{u} {what}", false,
                        what == "DATABASE" ? new DdlTarget(u, "database", null, null, null, DdlScope.Database) : ObjectAt(u, ObjectTypes.Table, i + j + 1), start);
                if (u == "DROP" && what is "PARTITION") return new(StatementCategory.Ddl, "DROP PARTITION", false, null, start);
                return null;
            }
            default:
                return null;
        }
    }

    /// <summary><c>WHERE 1</c> / <c>WHERE true</c> after a ClickHouse mutation: deletes or updates every row.</summary>
    private static bool WhereIsTrivial(List<SqlToken> t, int from)
    {
        var w = FirstDepth0Index(t, from, "WHERE");
        if (w < 0 || w + 1 >= t.Count) return false;
        var last = w + 2 >= t.Count || t[w + 2].IsPunct(';');
        return last && (t[w + 1].Value is "1" || t[w + 1].IsWord("TRUE"));
    }
    // WP-CH end

    // WP-SF begin (Snowflake: SHOW, DESCRIBE/DESC, LIST/LS, GET/PUT, COPY INTO, USE WAREHOUSE/ROLE, CALL, UNDROP, …)
    private static readonly HashSet<string> SnowflakeDdlModifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        "TRANSIENT", "SECURE", "DYNAMIC", "EXTERNAL", "HYBRID", "ICEBERG", "RECURSIVE", "VOLATILE", "EVENT",
    };

    private static StatementClassification? ClassifySnowflake(List<SqlToken> t, int i, string u, bool hasWhere, int start)
    {
        string? Word(int k) => k < t.Count && t[k].Kind == SqlTokenKind.Word ? t[k].Upper : null;
        switch (u)
        {
            case "SHOW":
            case "DESCRIBE":
            case "DESC":
            case "LIST":
            case "LS":
            case "GET":
                return new(StatementCategory.Query, u switch { "DESC" => "DESCRIBE", "LS" => "LIST", _ => u }, false, null, start);
            case "USE":
            case "UNSET":
                return new(StatementCategory.Session, u, false, null, start);
            case "ALTER" when Word(i + 1) == "SESSION":
                return new(StatementCategory.Session, "ALTER SESSION", false, null, start);
            case "PUT":
                return new(StatementCategory.Dml, "PUT", false, null, start);
            case "COPY":
                return new(StatementCategory.Dml, "COPY", hasWhere, null, start);
            case "REMOVE":
            case "RM":
                return new(StatementCategory.Dml, "REMOVE", false, null, start);
            case "CALL":
                return new(StatementCategory.Other, "CALL", false, null, start);
            case "EXECUTE" when Word(i + 1) == "IMMEDIATE":
                return new(StatementCategory.Block, "EXECUTE IMMEDIATE", hasWhere, null, start);
            case "EXECUTE" when Word(i + 1) == "TASK":
                return new(StatementCategory.Other, "EXECUTE TASK", false, null, start);
            case "BEGIN":
            {
                var tx = i + 1 >= t.Count || t[i + 1].IsPunct(';') || Word(i + 1) is "TRANSACTION" or "WORK" or "NAME";
                return tx ? new(StatementCategory.Transaction, "BEGIN", false, null, start) : new(StatementCategory.Block, "BEGIN", hasWhere, null, start);
            }
            case "START" when Word(i + 1) == "TRANSACTION":
                return new(StatementCategory.Transaction, "BEGIN", false, null, start);
            case "DECLARE":
                return new(StatementCategory.Block, "DECLARE", hasWhere, null, start);
            case "UNDROP":
                return ClassifyDdl(t, i, "UNDROP", Dialect.Snowflake, start);
            case "CREATE":
            case "ALTER":
            case "DROP":
            {
                // CREATE [OR REPLACE] [TRANSIENT | SECURE | DYNAMIC | EXTERNAL | HYBRID | …] TABLE/VIEW …: drop the Snowflake
                // modifiers before the type word so the shared DDL rules see TABLE / VIEW / FUNCTION.
                var k = i + 1;
                var removed = false;
                var filtered = new List<SqlToken>(t.Count);
                filtered.AddRange(t.Take(i + 1));
                for (; k < t.Count && t[k].Kind == SqlTokenKind.Word; k++)
                {
                    var w = t[k].Upper;
                    if (SnowflakeDdlModifiers.Contains(w)) { removed = true; continue; }
                    if (w is "OR" or "REPLACE" or "TEMP" or "TEMPORARY" or "LOCAL" or "GLOBAL") { filtered.Add(t[k]); continue; }
                    break;
                }
                if (!removed) return null;
                filtered.AddRange(t.Skip(k));
                return ClassifyDdl(filtered, i, u, Dialect.Snowflake, start);
            }
        }
        return null;
    }
    // WP-SF end

    // WP-CS begin (CQL: BEGIN BATCH … APPLY BATCH = Dml, DESCRIBE/DESC, USE, LIST ROLES/USERS, GRANT/REVOKE, …)
    private static StatementClassification? ClassifyCql(List<SqlToken> t, int i, string u, bool hasWhere, int start) => null;
    // WP-CS end

    private static StatementClassification ClassifyPragma(List<SqlToken> t, int i)
    {
        var start = t[0].Start;
        var nameParts = NameAfter(t, i + 1, out var next);
        var name = nameParts?.LastOrDefault() ?? "";
        // Setting a pragma can change the database file (journal_mode, user_version, ...): not a query.
        if (next < t.Count && t[next].Kind == SqlTokenKind.Operator && t[next].Value == "=")
            return new(StatementCategory.Other, "PRAGMA", false, null, start);
        if (next < t.Count && t[next].IsPunct('(') && !ReadOnlyPragmas.Contains(name))
            return new(StatementCategory.Other, "PRAGMA", false, null, start);
        return new(StatementCategory.Query, "PRAGMA", false, null, start);
    }

    private static readonly HashSet<string> DdlModifiers = new(StringComparer.OrdinalIgnoreCase)
    {
        "OR", "REPLACE", "ALTER", "UNIQUE", "CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "GLOBAL", "LOCAL",
        "EDITIONABLE", "NONEDITIONABLE", "EDITIONING", "FORCE", "NOFORCE", "BITMAP", "SPATIAL", "FULLTEXT",
        "XML", "PRIMARY", "VIRTUAL", "PUBLIC", "TEMP", "TEMPORARY",
    };

    private static StatementClassification ClassifyDdl(List<SqlToken> t, int i, string action, Dialect dialect, int start)
    {
        var j = i + 1;
        var temporary = false;
        var isPublic = false;
        while (j < t.Count && t[j].Kind == SqlTokenKind.Word && DdlModifiers.Contains(t[j].Value))
        {
            var m = t[j].Upper;
            if (m is "TEMP" or "TEMPORARY" || (m == "GLOBAL" && dialect != Dialect.PlSql)) temporary = true;
            if (m == "PUBLIC") isPublic = true;
            // "CREATE OR ALTER PROC" (T-SQL): ALTER is a modifier only after OR.
            if (m == "ALTER" && !(j > i + 1 && t[j - 1].IsWord("OR"))) break;
            j++;
        }
        if (j >= t.Count || t[j].Kind != SqlTokenKind.Word)
            return new(StatementCategory.Ddl, action, false, null, start);

        var typeWord = t[j].Upper;
        j++;
        string? objectType;
        var scope = DdlScope.Object;
        switch (typeWord)
        {
            case "TABLE": objectType = ObjectTypes.Table; break;
            case "VIEW": objectType = ObjectTypes.View; break;
            case "MATERIALIZED":
                objectType = ObjectTypes.MView;
                if (j < t.Count && t[j].IsWord("VIEW")) j++;
                typeWord = "MATERIALIZED VIEW";
                break;
            case "INDEX": objectType = "index"; break;
            case "PROCEDURE":
            case "PROC": objectType = ObjectTypes.Proc; typeWord = "PROCEDURE"; break;
            case "FUNCTION": objectType = ObjectTypes.Func; break;
            case "TRIGGER": objectType = ObjectTypes.Trigger; break;
            case "SEQUENCE": objectType = ObjectTypes.Sequence; break;
            case "SYNONYM": objectType = ObjectTypes.Synonym; break;
            case "PACKAGE":
                objectType = ObjectTypes.Package;
                if (j < t.Count && t[j].IsWord("BODY")) { j++; typeWord = "PACKAGE BODY"; }
                break;
            case "DOMAIN": objectType = ObjectTypes.Type; break;
            case "TYPE":
                objectType = ObjectTypes.Type;
                if (j < t.Count && t[j].IsWord("BODY")) { j++; typeWord = "TYPE BODY"; }
                break;
            case "SCHEMA": objectType = "schema"; scope = DdlScope.Database; break;
            case "DATABASE": objectType = "database"; scope = DdlScope.Database; break;
            case "USER": objectType = "user"; scope = dialect == Dialect.PlSql ? DdlScope.Database : DdlScope.Object; break;
            default:
                objectType = null;
                break;
        }

        var kind = $"{action} {typeWord}";
        if (objectType is null) return new(StatementCategory.Ddl, kind, false, null, start);

        // IF [NOT] EXISTS
        if (j < t.Count && t[j].IsWord("IF"))
        {
            j++;
            if (j < t.Count && t[j].IsWord("NOT")) j++;
            if (j < t.Count && t[j].IsWord("EXISTS")) j++;
        }

        var parts = NameAfter(t, j, out var afterName);
        if (scope == DdlScope.Database)
            return new(StatementCategory.Ddl, kind, false, new DdlTarget(action, objectType, null, null, parts?.LastOrDefault(), scope), start);

        var (db, schema, name) = SplitName(parts, dialect);

        if (objectType is "index" or ObjectTypes.Trigger)
        {
            // The affected catalog object is the table after ON (the index/trigger name rarely carries a schema in T-SQL).
            var on = FirstDepth0Index(t, afterName, "ON");
            if (on >= 0)
            {
                var tableParts = NameAfter(t, on + 1, out _);
                if (tableParts is { Count: > 0 } && !tableParts[0].Equals("DATABASE", StringComparison.OrdinalIgnoreCase)
                    && !tableParts[0].Equals("ALL", StringComparison.OrdinalIgnoreCase))
                {
                    var (tdb, tschema, tname) = SplitName(tableParts, dialect);
                    db ??= tdb;
                    schema ??= tschema;
                    if (objectType == "index") name = tname;
                }
            }
        }

        if (isPublic && dialect == Dialect.PlSql) schema = "PUBLIC";
        if (temporary || (name is not null && dialect == Dialect.TSql && name.StartsWith('#'))
            || (dialect == Dialect.Sqlite && schema is not null && schema.Equals("temp", StringComparison.OrdinalIgnoreCase)))
            scope = DdlScope.Temporary;

        return new(StatementCategory.Ddl, kind, false, new DdlTarget(action, objectType, db, schema, name, scope), start);
    }

    /// <summary>T-SQL batches often omit semicolons: find further depth-0 CREATE/ALTER/DROP statements in the same segment.</summary>
    private static void AddEmbeddedTsqlDdl(List<SqlToken> st, List<StatementClassification> list)
    {
        if (st.Count == 0) return;
        var first = list[^1];
        // Module bodies (procedures, functions, triggers, views) are one statement up to the end of the batch.
        if (first.Ddl is { ObjectType: ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.Trigger or ObjectTypes.View } && first.Ddl.Action != "DROP")
            return;
        var depth = 0;
        for (var k = 1; k < st.Count; k++)
        {
            var tok = st[k];
            if (tok.IsPunct('(')) depth++;
            else if (tok.IsPunct(')')) depth = Math.Max(0, depth - 1);
            else if (depth == 0 && tok.Kind == SqlTokenKind.Word && tok.Upper is "CREATE" or "ALTER" or "DROP"
                     && !st[k - 1].IsPunct('.') && !st[k - 1].IsWord("OR") && !st[k - 1].IsWord("ON"))
            {
                var c = ClassifyDdl(st, k, tok.Upper, Dialect.TSql, tok.Start);
                if (c.Ddl is not null) list.Add(c);
                if (c.Ddl?.ObjectType is ObjectTypes.Proc or ObjectTypes.Func or ObjectTypes.Trigger or ObjectTypes.View && c.Ddl.Action != "DROP")
                    return;
            }
        }
    }

    private static bool HasSelectInto(List<SqlToken> t)
    {
        if (t.Count == 0 || !t[0].IsWord("SELECT") && !t[0].IsPunct('(')) return false;
        var depth = 0;
        for (var k = 0; k < t.Count - 1; k++)
        {
            if (t[k].IsPunct('(')) depth++;
            else if (t[k].IsPunct(')')) depth--;
            else if (depth == 0 && t[k].IsWord("INTO"))
            {
                var next = t[k + 1];
                return next.IsIdentifier && !next.Value.StartsWith('@');
            }
            else if (depth == 0 && t[k].IsWord("FROM")) return false;
        }
        return false;
    }

    private static DdlTarget? SelectIntoTarget(List<SqlToken> t, Dialect dialect)
    {
        var into = FirstDepth0Index(t, 0, "INTO");
        if (into < 0) return null;
        var (db, schema, name) = SplitName(NameAfter(t, into + 1, out _), dialect);
        var scope = name is not null && name.StartsWith('#') ? DdlScope.Temporary : DdlScope.Object;
        return new DdlTarget("SELECT INTO", ObjectTypes.Table, db, schema, name, scope);
    }

    /// <summary>Reads a dotted identifier chain starting at <paramref name="start"/>; null when no identifier is there.</summary>
    private static List<string>? NameAfter(List<SqlToken> t, int start, out int next)
    {
        next = start;
        if (start >= t.Count || !t[start].IsIdentifier) return null;
        var parts = new List<string> { t[start].Value };
        var k = start + 1;
        while (k + 1 < t.Count && t[k].IsPunct('.'))
        {
            // T-SQL "db..obj": empty schema part.
            if (t[k + 1].IsPunct('.')) { parts.Add(""); k++; continue; }
            if (!t[k + 1].IsIdentifier) break;
            parts.Add(t[k + 1].Value);
            k += 2;
        }
        next = k;
        return parts;
    }

    private static (string? Db, string? Schema, string? Name) SplitName(List<string>? parts, Dialect dialect)
    {
        if (parts is null || parts.Count == 0) return (null, null, null);
        static string? NullIfEmpty(string s) => s.Length == 0 ? null : s;
        return parts.Count switch
        {
            1 => (null, null, parts[0]),
            2 => (null, NullIfEmpty(parts[0]), parts[1]),
            3 when DialectInfo.HasDatabases(dialect) => (NullIfEmpty(parts[0]), NullIfEmpty(parts[1]), parts[2]), // T-SQL, PostgreSQL, Snowflake
            _ => (null, NullIfEmpty(parts[^2]), parts[^1]),
        };
    }

    private static bool HasDepth0Word(List<SqlToken> t, int from, string word) => FirstDepth0Index(t, from, word) >= 0;

    private static int FirstDepth0Index(List<SqlToken> t, int from, string word)
    {
        var depth = 0;
        for (var k = from; k < t.Count; k++)
        {
            if (t[k].IsPunct('(')) depth++;
            else if (t[k].IsPunct(')')) depth = Math.Max(0, depth - 1);
            else if (depth == 0 && t[k].IsWord(word)) return k;
        }
        return -1;
    }

    private static string? FirstDepth0Word(List<SqlToken> t, int from, params string[] words)
    {
        var depth = 0;
        for (var k = from; k < t.Count; k++)
        {
            if (t[k].IsPunct('(')) depth++;
            else if (t[k].IsPunct(')')) depth = Math.Max(0, depth - 1);
            else if (depth == 0 && t[k].Kind == SqlTokenKind.Word)
            {
                foreach (var w in words)
                    if (t[k].Value.Equals(w, StringComparison.OrdinalIgnoreCase)) return w;
            }
        }
        return null;
    }
}
