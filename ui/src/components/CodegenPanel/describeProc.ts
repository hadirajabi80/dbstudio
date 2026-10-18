// Result columns of a SQL Server procedure without running it: sys.dm_exec_describe_first_result_set_for_object
// analyses the procedure's first SELECT (the same metadata SQL Server uses for sp_describe_first_result_set). Pure
// helpers (SQL text, row parsing) live here so they are unit-tested; CodegenPanel runs the query.
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';

/** The describe query; `@name` is the procedure's (quoted) qualified name, bound as a parameter. */
export const DESCRIBE_PROC_SQL = [
  'SELECT name, system_type_name, is_nullable, column_ordinal, error_number, error_message',
  'FROM sys.dm_exec_describe_first_result_set_for_object(OBJECT_ID(@name), 0)',
  'WHERE ISNULL(is_hidden, 0) = 0',
  'ORDER BY column_ordinal',
].join('\n');

const KIND: [RegExp, ColumnKind][] = [
  [/^(bigint|int|smallint|tinyint)$/, 'int'],
  [/^bit$/, 'bool'],
  [/^(decimal|numeric|money|smallmoney)$/, 'decimal'],
  [/^(float|real)$/, 'float'],
  [/^date$/, 'date'],
  [/^time$/, 'time'],
  [/^(datetime|datetime2|smalldatetime)$/, 'datetime'],
  [/^datetimeoffset$/, 'datetimeoffset'],
  [/^uniqueidentifier$/, 'guid'],
  [/^(binary|varbinary|image|timestamp|rowversion)$/, 'binary'],
  [/^xml$/, 'xml'],
  [/^(char|varchar|nchar|nvarchar|text|ntext|sysname)$/, 'string'],
];

/** Wire kind of a SQL Server type text (`nvarchar(100)` → string). */
export function tsqlKind(typeText: string): ColumnKind {
  const base = typeText.trim().replace(/\s*\(.*$/, '').toLowerCase();
  return KIND.find(([re]) => re.test(base))?.[1] ?? 'other';
}

export type DescribeOutcome =
  | { ok: true; columns: ColumnInfo[] }
  /** The procedure returns no result set (or only through dynamic SQL / temp tables SQL Server cannot analyse). */
  | { ok: false; reason: string };

/** Rows of DESCRIBE_PROC_SQL (with the result set's column names) → result columns, or why there are none. */
export function parseDescribeRows(columns: Pick<ColumnInfo, 'name'>[], rows: CellValue[][]): DescribeOutcome {
  const at = (n: string) => columns.findIndex((c) => c.name.toLowerCase() === n);
  const iName = at('name'), iType = at('system_type_name'), iNull = at('is_nullable'), iOrd = at('column_ordinal'), iErr = at('error_message');
  const text = (v: CellValue | undefined) => (typeof v === 'string' ? v : v == null ? null : String(v));
  const failed = rows.find((r) => iErr >= 0 && r[iErr] != null);
  if (failed) return { ok: false, reason: text(failed[iErr]) ?? 'SQL Server could not describe the result set' };
  const out: ColumnInfo[] = [];
  rows.forEach((r, i) => {
    const type = text(r[iType]);
    if (!type) return;
    const ord = Number(r[iOrd]);
    const nullable = r[iNull];
    out.push({
      name: text(r[iName]) ?? '',
      ordinal: Number.isFinite(ord) && ord > 0 ? ord - 1 : i,
      dbType: type,
      kind: tsqlKind(type),
      nullable: nullable === true || nullable === 1 || nullable === '1',
      size: null,
      precision: null,
      scale: null,
      table: null,
      schema: null,
      isKey: false,
    });
  });
  if (!out.length) return { ok: false, reason: 'it returns no result set' };
  return { ok: true, columns: out };
}
