import type { CatalogObjectType, Dialect, ObjectRef } from '../api/types';

const TSQL_RESERVED = new Set(
  'ADD ALL ALTER AND ANY AS ASC BACKUP BEGIN BETWEEN BREAK BROWSE BULK BY CASCADE CASE CHECK CHECKPOINT CLOSE CLUSTERED COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTINUE CONVERT CREATE CROSS CURRENT CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISTINCT DISTRIBUTED DOUBLE DROP ELSE END ERRLVL ESCAPE EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE FILLFACTOR FOR FOREIGN FREETEXT FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK IDENTITY IF IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY KILL LEFT LIKE LINENO MERGE NATIONAL NOCHECK NONCLUSTERED NOT NULL NULLIF OF OFF OFFSETS ON OPEN OPTION OR ORDER OUTER OVER PERCENT PIVOT PLAN PRIMARY PRINT PROC PROCEDURE PUBLIC RAISERROR READ RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE RIGHT ROLLBACK ROWCOUNT RULE SAVE SCHEMA SELECT SET SETUSER SHUTDOWN SOME STATISTICS TABLE TEXTSIZE THEN TO TOP TRAN TRANSACTION TRIGGER TRUNCATE UNION UNIQUE UNPIVOT UPDATE USE USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH'.split(' '),
);
const COMMON_RESERVED = new Set(
  'ADD ALL ALTER AND ANY AS ASC BETWEEN BY CASE CHECK COLUMN CONSTRAINT CREATE CROSS CURRENT DEFAULT DELETE DESC DISTINCT DROP ELSE END EXCEPT EXISTS FOR FOREIGN FROM FULL GROUP HAVING IN INDEX INNER INSERT INTERSECT INTO IS JOIN KEY LEFT LIKE LIMIT NOT NULL OF ON OR ORDER OUTER PRIMARY REFERENCES RIGHT ROW ROWS SELECT SET TABLE THEN TO UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHERE WITH LEVEL NUMBER DATE SIZE'.split(' '),
);

/** PostgreSQL reserved key words (fully reserved plus "reserved, can be function or type"; PG 17 appendix C). */
export const PG_RESERVED = new Set(
  'ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC AUTHORIZATION BINARY BOTH CASE CAST CHECK COLLATE COLLATION COLUMN CONCURRENTLY CONSTRAINT CREATE CROSS CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_SCHEMA CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DEFERRABLE DESC DISTINCT DO ELSE END EXCEPT FALSE FETCH FOR FOREIGN FREEZE FROM FULL GRANT GROUP HAVING ILIKE IN INITIALLY INNER INTERSECT INTO IS ISNULL JOIN LATERAL LEADING LEFT LIKE LIMIT LOCALTIME LOCALTIMESTAMP NATURAL NOT NOTNULL NULL OFFSET ON ONLY OR ORDER OUTER OVERLAPS PLACING PRIMARY REFERENCES RETURNING RIGHT SELECT SESSION_USER SIMILAR SOME SYMMETRIC SYSTEM_USER TABLE TABLESAMPLE THEN TO TRAILING TRUE UNION UNIQUE USER USING VARIADIC VERBOSE WHEN WHERE WINDOW WITH'.split(' '),
);

export function needsQuoting(name: string, dialect: Dialect): boolean {
  if (dialect === 'pgsql') {
    // Unquoted identifiers fold to lower case, so anything else is quoted to keep its spelling.
    return !/^[a-z_][a-z0-9_$]*$/.test(name) || PG_RESERVED.has(name.toUpperCase());
  }
  if (dialect === 'plsql') {
    if (!/^[A-Z][A-Z0-9_$#]*$/.test(name)) return true;
  } else if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(name)) {
    return true;
  }
  const up = name.toUpperCase();
  return dialect === 'tsql' ? TSQL_RESERVED.has(up) : COMMON_RESERVED.has(up);
}

export function quoteIdent(name: string, dialect: Dialect, force = false): string {
  if (!force && !needsQuoting(name, dialect)) return name;
  if (dialect === 'tsql') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** schema.name, omitting the schema when it is the default (unless always). */
export function qualifiedName(
  ref: Pick<ObjectRef, 'schema' | 'name'>,
  dialect: Dialect,
  opts: { defaultSchema?: string | null; always?: boolean } = {},
): string {
  const name = quoteIdent(ref.name, dialect);
  if (!ref.schema) return name;
  if (dialect === 'sqlite' && ref.schema === 'main' && !opts.always) return name;
  if (!opts.always && opts.defaultSchema && ref.schema === opts.defaultSchema) return name;
  return `${quoteIdent(ref.schema, dialect)}.${name}`;
}

export function selectTopSql(ref: ObjectRef, dialect: Dialect, n: number, defaultSchema?: string | null): string {
  const q = qualifiedName(ref, dialect, { defaultSchema, always: dialect === 'tsql' });
  switch (dialect) {
    case 'tsql':
      return `SELECT TOP ${n} *\nFROM ${q};`;
    case 'plsql':
      return `SELECT *\nFROM ${q}\nFETCH FIRST ${n} ROWS ONLY;`;
    default:
      return `SELECT *\nFROM ${q}\nLIMIT ${n};`;
  }
}

export function isTabular(t: CatalogObjectType): boolean {
  return t === 'table' || t === 'view' || t === 'mview' || t === 'synonym' || t === 'tablefunc';
}

export const OBJECT_TYPE_LABELS: Record<CatalogObjectType, string> = {
  table: 'Tables',
  view: 'Views',
  mview: 'Materialized Views',
  proc: 'Procedures',
  func: 'Functions',
  tablefunc: 'Table Functions',
  synonym: 'Synonyms',
  sequence: 'Sequences',
  package: 'Packages',
  type: 'Types',
  trigger: 'Triggers',
};

export const OBJECT_TYPE_SINGULAR: Record<CatalogObjectType, string> = {
  table: 'table',
  view: 'view',
  mview: 'materialized view',
  proc: 'procedure',
  func: 'function',
  tablefunc: 'table function',
  synonym: 'synonym',
  sequence: 'sequence',
  package: 'package',
  type: 'type',
  trigger: 'trigger',
};

/** Order of object-type folders in the explorer. */
export const OBJECT_TYPE_ORDER: CatalogObjectType[] = [
  'table', 'view', 'mview', 'proc', 'func', 'tablefunc', 'package', 'sequence', 'synonym', 'type', 'trigger',
];
