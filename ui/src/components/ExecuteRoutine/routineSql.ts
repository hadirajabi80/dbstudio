// Execute routine (SSMS "Execute Stored Procedure", Navicat's run dialog): the call SQL for a procedure or function
// and the bind values that go with it. Pure and unit-tested. Values are always bind parameters (ExecuteRequest.params,
// bound by the engine's per-provider binders); the SQL text only ever holds placeholders, NULL, DEFAULT and names.
//
//   SQL Server  DECLARE @return_value int, @Total money;
//               EXEC @return_value = [dbo].[proc] @Id = @Id, @Total = @Total OUTPUT;
//               SELECT @return_value AS [Return value], @Total AS [Total];
//               (sp_executesql parameters are local variables: an OUTPUT argument writes back into the variable and
//               the final SELECT returns every output as one result row, so no engine change is needed)
//               SELECT [dbo].[fn](@a, DEFAULT) AS [Result];   SELECT * FROM [dbo].[tvf](@a);
//   Oracle      BEGIN SHOP.PKG.PROC(P_ID => :p_id, P_CUR => :p_cur); END;   -- OUT / REF CURSOR as out binds
//               BEGIN :result := SHOP.FN(P_ID => :p_id); END;
//   PostgreSQL  CALL public.proc($1::bigint, $2::integer, p_line_no => NULL);   -- positional, then named after a default
//               SELECT public.fn($1::numeric);   SELECT * FROM public.tvf($1::bigint);
import type { CatalogObjectType, CatalogParamTuple, Dialect, ParamKind, QueryParam } from '../../api/types';
import { convertValue } from '../ParamsDialog/ParamsDialog';

export type RoutineKind = 'proc' | 'func' | 'tablefunc';
export type ParamDirectionText = 'in' | 'out' | 'inout';

export interface RoutineParam {
  name: string;
  type: string;
  direction: ParamDirectionText;
  hasDefault: boolean;
}

export interface RoutineSpec {
  dialect: Dialect;
  kind: RoutineKind;
  /** SQL Server: the database, when the call runs in a console on another database (three-part name). */
  database?: string | null;
  schema: string | null;
  /** Oracle: the package of a package member. */
  packageName?: string | null;
  name: string;
  /** Arguments in declaration order (the "return" entry is in `returnType`). */
  params: RoutineParam[];
  returnType: string | null;
  /** Oracle package member overload (1-based), for labels. */
  overload?: number;
}

/** How one parameter is passed: a value, NULL, or the routine's default (the argument is omitted). */
export type ParamMode = 'value' | 'null' | 'default';
export interface ParamInput {
  mode: ParamMode;
  value: string;
}

export interface RoutineCall {
  sql: string;
  params: QueryParam[];
  /** Per parameter: why its value cannot be sent (null = fine). */
  errors: (string | null)[];
  /** A problem with the call as a whole (e.g. a PostgreSQL argument that cannot be named). */
  error: string | null;
  /** Binds whose value is missing or invalid (sent as NULL until fixed; the preview marks them). */
  invalid: string[];
}

/** Routine types the dialog can execute (packages pick one of their members). */
export const EXECUTABLE_TYPES = new Set<CatalogObjectType>(['proc', 'func', 'tablefunc']);

export function routineNoun(kind: RoutineKind | CatalogObjectType): string {
  return kind === 'proc' ? 'procedure' : kind === 'package' ? 'package' : 'function';
}

/** Arguments and return type from catalog tuples (`CatalogObject.p`, package members). */
export function specParams(tuples: readonly CatalogParamTuple[]): { params: RoutineParam[]; returnType: string | null } {
  const params: RoutineParam[] = [];
  let returnType: string | null = null;
  for (const [name, type, direction, hasDefault] of tuples) {
    if (direction === 'return') returnType = type;
    else params.push({ name, type, direction, hasDefault: hasDefault === 1 });
  }
  return { params, returnType };
}

/** Name without the SQL Server `@` and the PostgreSQL `VARIADIC ` prefix. */
export function bareParamName(p: RoutineParam): string {
  return p.name.replace(/^VARIADIC\s+/i, '').replace(/^@/, '');
}

const isVariadic = (p: RoutineParam) => /^VARIADIC\s/i.test(p.name);
/** PostgreSQL unnamed arguments are reported as `$n`: they cannot be passed by name. */
const isUnnamed = (p: RoutineParam) => !bareParamName(p) || /^\$\d+$/.test(bareParamName(p));

/** Bind kind for a declared type (the value editor and the engine's typed bind follow it). */
export function paramKindOf(type: string, dialect: Dialect): ParamKind {
  const t = type.trim().toLowerCase();
  const base = t.replace(/\(.*$/, '').replace(/\[\]$/, '').trim();
  if (t.endsWith('[]')) return 'string';
  if (/ref\s*cursor|refcursor/.test(t)) return dialect === 'plsql' ? 'refcursor' : 'string';
  if (['int', 'integer', 'bigint', 'smallint', 'tinyint', 'int2', 'int4', 'int8', 'serial', 'bigserial', 'smallserial', 'pls_integer', 'binary_integer', 'natural', 'naturaln', 'positive', 'positiven', 'simple_integer'].includes(base)) return 'int';
  if (base === 'number') {
    const m = /\(\s*(\d+|\*)\s*(?:,\s*(-?\d+)\s*)?\)/.exec(t);
    return m && m[1] !== '*' && (m[2] === undefined || m[2] === '0') ? 'int' : 'decimal';
  }
  if (['decimal', 'numeric', 'money', 'smallmoney', 'dec'].includes(base)) return 'decimal';
  if (['float', 'real', 'double precision', 'float4', 'float8', 'binary_double', 'binary_float', 'double'].includes(base)) return 'float';
  if (['bit', 'boolean', 'bool'].includes(base)) return 'bool';
  if (base === 'date') return dialect === 'plsql' ? 'datetime' : 'date'; // Oracle DATE has a time part
  if (/^timestamp.*with (local )?time zone$/.test(t) || ['datetimeoffset', 'timestamptz'].includes(base)) return 'datetimeoffset';
  if (['datetime', 'datetime2', 'smalldatetime', 'timestamp'].includes(base) || /^timestamp/.test(base)) return 'datetime';
  if (['time', 'timetz'].includes(base) || /^time without time zone$/.test(t)) return 'time';
  if (base === 'uniqueidentifier') return 'guid';
  if (['varbinary', 'binary', 'image', 'bytea', 'raw', 'blob', 'long raw'].includes(base)) return 'binary';
  return 'string';
}

export type ValueEditor = 'line' | 'multiline' | 'number' | 'bool' | 'date' | 'datetime' | 'time';

/** The input used for a parameter: typed editors for numbers, booleans and dates, a text area for long text and JSON. */
export function valueEditorOf(type: string, kind: ParamKind): ValueEditor {
  switch (kind) {
    case 'int':
    case 'decimal':
    case 'float':
      return 'number';
    case 'bool':
      return 'bool';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'time':
      return 'time';
    default: {
      const t = type.toLowerCase();
      if (/\b(text|ntext|clob|nclob|xml|xmltype|json|jsonb|long)\b|\(max\)/.test(t)) return 'multiline';
      const len = /\((\d+)/.exec(t);
      return len && Number(len[1]) >= 500 ? 'multiline' : 'line';
    }
  }
}

/** Is the parameter only written by the routine (no value to enter)? */
export function isOutputOnly(p: RoutineParam): boolean {
  return p.direction === 'out';
}

/** The default mode of a parameter: its default when it has one, else an (empty) value. */
export function initialInput(p: RoutineParam): ParamInput {
  return { mode: p.hasDefault ? 'default' : 'value', value: '' };
}

// ---------------------------------------------------------------------------------------------- quoting

function bracket(s: string): string {
  return `[${s.replace(/]/g, ']]')}]`;
}

const ORACLE_RESERVED = new Set(
  ('ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT '
    + 'DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED '
    + 'IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MLSLABEL MODE '
    + 'MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME '
    + 'RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN '
    + 'TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH BEGIN END RESULT').split(' '),
);

function oracleIdent(s: string): string {
  return /^[A-Z][A-Z0-9_$#]*$/.test(s) && !ORACLE_RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`;
}

const PG_RESERVED = new Set(
  ('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog '
    + 'current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except '
    + 'false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not '
    + 'null offset on only or order placing primary references returning select session_user some symmetric table then to trailing '
    + 'true union unique user using variadic when where window with').split(' '),
);

function pgIdent(s: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(s) && !PG_RESERVED.has(s) ? s : `"${s.replace(/"/g, '""')}"`;
}

export function routineName(spec: RoutineSpec): string {
  switch (spec.dialect) {
    case 'tsql':
      return [spec.database, spec.schema, spec.name].filter((x): x is string => !!x).map(bracket).join('.');
    case 'plsql':
      return [spec.schema, spec.packageName, spec.name].filter((x): x is string => !!x).map(oracleIdent).join('.');
    default:
      return [spec.schema, spec.name].filter((x): x is string => !!x).map(pgIdent).join('.');
  }
}

/** A readable label: `dbo.GetCustomer`, `SHOP.ORDER_API.GET_TOTAL`, `public.fn_tax(numeric, numeric)`. */
export function routineLabel(spec: RoutineSpec): string {
  return [spec.schema, spec.packageName, spec.name].filter(Boolean).join('.');
}

// ---------------------------------------------------------------------------------------------- binds

/** The bind value of one input; `{ error }` when it does not parse as the parameter's kind. */
function bindValue(kind: ParamKind, input: ParamInput): { value: QueryParam['value'] } | { error: string } {
  if (kind === 'string' || kind === 'binary' || kind === 'guid') {
    if (kind !== 'string' && !input.value.trim()) return { error: 'Enter a value, or choose NULL' };
  } else if (!input.value.trim()) {
    return { error: 'Enter a value, or choose NULL' };
  }
  const c = convertValue(kind, input.value);
  return c.ok ? { value: c.value } : { error: c.error };
}

/** Bind name for SQL Server / Oracle: the parameter's own name when it is a safe identifier, else `p<n>`. */
function bindNameFor(p: RoutineParam, index: number, dialect: Dialect, taken: Set<string>): string {
  const bare = bareParamName(p);
  let name = bare;
  if (dialect === 'plsql') {
    name = bare.toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(name) || ORACLE_RESERVED.has(name.toUpperCase())) name = `p${index + 1}`;
  } else if (!/^[A-Za-z_#$][\w#$@]*$/.test(name)) {
    name = `p${index + 1}`;
  }
  while (taken.has(name.toLowerCase())) name = `${name}_`;
  taken.add(name.toLowerCase());
  return name;
}

function freeName(base: string, taken: Set<string>): string {
  let n = base;
  while (taken.has(n.toLowerCase())) n = `${n}_`;
  taken.add(n.toLowerCase());
  return n;
}

const SEP = (args: string[], indent = '    ') => (args.length > 2 ? `\n${indent}${args.join(`,\n${indent}`)}` : args.length ? ` ${args.join(', ')}` : '');
const LIST = (args: string[], indent = '    ') => (args.length > 3 ? `(\n${indent}${args.join(`,\n${indent}`)}\n)` : `(${args.join(', ')})`);

/**
 * The call for `spec` with `inputs` (one per `spec.params`, in order). Output-only parameters ignore their input.
 * The SQL and the binds are complete even when some values are invalid; `errors` says which ones.
 */
export function buildRoutineCall(spec: RoutineSpec, inputs: readonly ParamInput[]): RoutineCall {
  switch (spec.dialect) {
    case 'tsql':
      return buildTsql(spec, inputs);
    case 'plsql':
      return buildOracle(spec, inputs);
    case 'pgsql':
      return buildPg(spec, inputs);
    default:
      return { sql: '', params: [], errors: spec.params.map(() => null), error: 'SQLite has no stored procedures or functions.', invalid: [] };
  }
}

function inputOf(inputs: readonly ParamInput[], i: number, p: RoutineParam): ParamInput {
  return inputs[i] ?? initialInput(p);
}

function buildTsql(spec: RoutineSpec, inputs: readonly ParamInput[]): RoutineCall {
  const invalid: string[] = [];
  const name = routineName(spec);
  const errors: (string | null)[] = [];
  const params: QueryParam[] = [];
  const taken = new Set(spec.params.map((p) => bareParamName(p).toLowerCase()));
  const args: string[] = [];
  const declares: string[] = [];
  const outputs: string[] = [];
  const isProc = spec.kind === 'proc';
  spec.params.forEach((p, i) => {
    const input = inputOf(inputs, i, p);
    const bare = bareParamName(p);
    const formal = `@${bare}`;
    let arg: string | null;
    errors.push(null);
    if (isOutputOnly(p) && isProc) {
      // OUTPUT parameter: a local variable the procedure writes, returned by the final SELECT.
      declares.push(`@${bare} ${p.type || 'sql_variant'}`);
      outputs.push(`@${bare} AS ${bracket(bare)}`);
      arg = `${formal} = @${bare} OUTPUT`;
    } else if (input.mode === 'default' && p.hasDefault) {
      arg = isProc ? null : 'DEFAULT';
    } else if (input.mode === 'null') {
      arg = isProc ? `${formal} = NULL` : 'NULL';
    } else {
      const kind = paramKindOf(p.type, 'tsql');
      const v = bindValue(kind, input);
      if ('error' in v) { errors[i] = v.error; invalid.push(bare); }
      params.push({ name: bare, kind, value: 'error' in v ? null : v.value });
      arg = isProc ? `${formal} = @${bare}` : `@${bare}`;
    }
    if (arg !== null) args.push(arg);
  });

  let sql: string;
  if (isProc) {
    const rc = freeName('return_value', taken);
    declares.unshift(`@${rc} int`);
    outputs.unshift(`@${rc} AS [Return value]`);
    sql = `DECLARE ${declares.join(', ')};\nEXEC @${rc} = ${name}${SEP(args)};\nSELECT ${outputs.join(', ')};`;
  } else if (spec.kind === 'tablefunc') {
    sql = `SELECT * FROM ${name}${LIST(args)};`;
  } else {
    sql = `SELECT ${name}${LIST(args)} AS [Result];`;
  }
  return { sql, params, errors, error: null, invalid };
}

function buildOracle(spec: RoutineSpec, inputs: readonly ParamInput[]): RoutineCall {
  const invalid: string[] = [];
  const name = routineName(spec);
  const errors: (string | null)[] = [];
  const params: QueryParam[] = [];
  const taken = new Set<string>();
  const args: string[] = [];
  spec.params.forEach((p, i) => {
    const input = inputOf(inputs, i, p);
    const formal = oracleIdent(bareParamName(p));
    const kind = paramKindOf(p.type, 'plsql');
    errors.push(null);
    if (isOutputOnly(p) || kind === 'refcursor') {
      const bind = bindNameFor(p, i, 'plsql', taken);
      params.push({ name: bind, kind, value: null, direction: 'out' });
      args.push(`${formal} => :${bind}`);
      return;
    }
    if (input.mode === 'default' && p.hasDefault) return;
    if (input.mode === 'null') {
      if (p.direction === 'inout') {
        // An IN OUT argument must be a variable: bind NULL so the value written back is returned.
        const bind = bindNameFor(p, i, 'plsql', taken);
        params.push({ name: bind, kind, value: null, direction: 'inout' });
        args.push(`${formal} => :${bind}`);
      } else args.push(`${formal} => NULL`);
      return;
    }
    const v = bindValue(kind, input);
    const bind = bindNameFor(p, i, 'plsql', taken);
    if ('error' in v) { errors[i] = v.error; invalid.push(bind); }
    params.push({ name: bind, kind, value: 'error' in v ? null : v.value, ...(p.direction === 'inout' ? { direction: 'inout' as const } : {}) });
    args.push(`${formal} => :${bind}`);
  });
  const call = args.length ? `${name}${LIST(args, '    ')}` : name;
  let sql: string;
  if (spec.kind === 'tablefunc') {
    sql = `SELECT * FROM TABLE(${name}${LIST(args)})`;
  } else if (spec.kind === 'func') {
    const result = freeName('result', taken);
    const kind = paramKindOf(spec.returnType ?? '', 'plsql');
    params.push({ name: result, kind, value: null, direction: 'out' });
    sql = `BEGIN\n  :${result} := ${args.length ? `${name}${LIST(args, '    ')}` : name};\nEND;`;
  } else {
    sql = `BEGIN\n  ${call};\nEND;`;
  }
  return { sql, params, errors, error: null, invalid };
}

function buildPg(spec: RoutineSpec, inputs: readonly ParamInput[]): RoutineCall {
  const invalid: string[] = [];
  const name = routineName(spec);
  const errors: (string | null)[] = [];
  const params: QueryParam[] = [];
  const args: string[] = [];
  let named = false;
  let error: string | null = null;
  const isProc = spec.kind === 'proc';
  const cast = (p: RoutineParam) => (p.type && !/^(unknown|any|anyelement|"?any"?)$/i.test(p.type) ? `::${p.type}` : '');
  spec.params.forEach((p, i) => {
    const input = inputOf(inputs, i, p);
    errors.push(null);
    // Function OUT parameters are not arguments (they shape the result); procedure OUT arguments are written as NULL.
    if (isOutputOnly(p) && !isProc) return;
    let expr: string | null;
    if (isOutputOnly(p)) expr = 'NULL';
    else if (input.mode === 'default' && p.hasDefault) expr = null;
    else if (input.mode === 'null') expr = 'NULL';
    else {
      const kind = paramKindOf(p.type, 'pgsql');
      const v = bindValue(kind, input);
      if ('error' in v) { errors[i] = v.error; invalid.push(String(params.length + 1)); }
      params.push({ name: String(params.length + 1), kind, value: 'error' in v ? null : v.value });
      expr = `$${params.length}${cast(p)}`;
    }
    if (expr === null) {
      named = true; // an omitted argument: every later one is passed by name
      return;
    }
    const variadic = isVariadic(p) ? 'VARIADIC ' : '';
    if (named) {
      if (isUnnamed(p) || isVariadic(p)) {
        error ??= `Argument ${i + 1} has no name, so it cannot follow an argument that uses its default. Give the earlier arguments a value.`;
        args.push(`${variadic}${expr}`);
      } else args.push(`${pgIdent(bareParamName(p))} => ${expr}`);
    } else args.push(`${variadic}${expr}`);
  });
  const hasOutCols = spec.params.some((p) => p.direction !== 'in');
  const call = `${name}${LIST(args)}`;
  const sql = isProc ? `CALL ${call};` : spec.kind === 'tablefunc' || (!isProc && hasOutCols) ? `SELECT * FROM ${call};` : `SELECT ${call};`;
  return { sql, params, errors, error, invalid };
}
