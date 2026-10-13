namespace DbStudio.Providers.Oracle;

/// <summary>Oracle SQL reserved words (V$RESERVED_WORDS where RESERVED='Y', plus PL/SQL reserved words); such identifiers need quotes.</summary>
public static class OracleReservedWords
{
    public static IReadOnlySet<string> All { get; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "ACCESS", "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "AUDIT", "BEGIN", "BETWEEN", "BY", "CASE", "CHAR", "CHECK",
        "CLUSTER", "CLUSTERS", "COLAUTH", "COLUMN", "COLUMNS", "COMMENT", "COMPRESS", "CONNECT", "CRASH", "CREATE", "CURRENT",
        "CURSOR", "DATE", "DECIMAL", "DECLARE", "DEFAULT", "DELETE", "DESC", "DISTINCT", "DROP", "ELSE", "END", "EXCEPTION",
        "EXCLUSIVE", "EXISTS", "FETCH", "FILE", "FLOAT", "FOR", "FROM", "FUNCTION", "GOTO", "GRANT", "GROUP", "HAVING", "IDENTIFIED",
        "IF", "IMMEDIATE", "IN", "INCREMENT", "INDEX", "INDEXES", "INITIAL", "INSERT", "INTEGER", "INTERSECT", "INTO", "IS", "LEVEL",
        "LIKE", "LOCK", "LONG", "MAXEXTENTS", "MINUS", "MLSLABEL", "MODE", "MODIFY", "NOAUDIT", "NOCOMPRESS", "NOT", "NOWAIT", "NULL",
        "NUMBER", "OF", "OFFLINE", "ON", "ONLINE", "OPTION", "OR", "ORDER", "OVERLAPS", "PCTFREE", "PRIOR", "PROCEDURE", "PUBLIC",
        "RAW", "RENAME", "RESOURCE", "REVOKE", "ROW", "ROWID", "ROWNUM", "ROWS", "SELECT", "SESSION", "SET", "SHARE", "SIZE",
        "SMALLINT", "SQL", "START", "SUBTYPE", "SUCCESSFUL", "SYNONYM", "SYSDATE", "TABAUTH", "TABLE", "THEN", "TO", "TRIGGER",
        "TYPE", "UID", "UNION", "UNIQUE", "UPDATE", "USER", "VALIDATE", "VALUES", "VARCHAR", "VARCHAR2", "VIEW", "VIEWS", "WHEN",
        "WHENEVER", "WHERE", "WITH",
    };
}
