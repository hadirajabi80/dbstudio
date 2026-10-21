// Structure model of one statement (PLAN 4.6): scopes, table sources, CTEs, projections, clause markers.
import type { Token } from '../types';

export type ClauseKind =
  | 'select' | 'from' | 'join' | 'on' | 'where' | 'groupBy' | 'having' | 'orderBy' | 'into' | 'insertColumns'
  | 'values' | 'set' | 'update' | 'delete' | 'with' | 'cteColumns' | 'using' | 'returning' | 'limit' | 'exec'
  | 'execArgs' | 'declare' | 'ddl' | 'unknown'
  /** PostgreSQL `expr::|` / `CAST(expr AS |`: a data type. */
  | 'cast'
  /** Procedural expression (PL/SQL statement, T-SQL SET/PRINT/IF condition): variables, functions, packages. */
  | 'expr';

export type ScopeKind =
  | 'select' | 'insert' | 'update' | 'delete' | 'merge' | 'cte' | 'subquery' | 'exists' | 'values' | 'plsqlBlock'
  | 'other';

export interface NamePart { text: string; quoted: boolean; range: [number, number] }

export type DdlWhat =
  | 'newName'      // a name being defined: no suggestions
  | 'objectName'   // existing object of `objectType`
  | 'columnOf'     // existing column of `table`
  | 'dataType'     // column / parameter data type
  | 'columnName';  // new column name in a definition: no suggestions

export interface MarkerData {
  joinRef?: TableRef;
  /** SELECT ... INTO (T-SQL temp table / PL/SQL variables) vs INSERT INTO table. */
  selectInto?: boolean;
  ddl?: { what: DdlWhat; objectType?: string; table?: TableRef };
  /** declare: expecting a data type (after the variable name). */
  expectType?: boolean;
  /** exec: procedure name parts (for execArgs). */
  proc?: NamePart[];
  /** Statement start inside a block. */
  statementStart?: boolean;
  /** INSERT … ON CONFLICT: conflict target (`ON CONFLICT |`, `(cols)`) or action (`DO NOTHING` / `DO UPDATE SET`). */
  conflict?: 'target' | 'columns' | 'action' | 'do';
}

export interface Marker { pos: number; clause: ClauseKind; data?: MarkerData }

export interface ColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  isPk?: boolean;
  identity?: boolean;
  computed?: boolean;
  hidden?: boolean;
  comment?: string | null;
  ordinal: number;
  /** Where the column comes from (for details and hover). */
  origin?: { schema: string | null; table: string };
  /** Definition range in the document (temp tables, table variables, CTE projections). */
  defRange?: [number, number];
}

export type TableRefKind =
  | 'table' | 'subquery' | 'cte' | 'function' | 'synonym' | 'tempTable' | 'tableVar' | 'values' | 'unresolved';

export interface TableRef {
  kind: TableRefKind;
  parts: NamePart[];
  alias: string | null;
  aliasQuoted?: boolean;
  aliasRange: [number, number] | null;
  nameRange: [number, number];
  /** Whole source text range incl. alias. */
  range: [number, number];
  subScope?: Scope;
  columnAliases?: string[];
  /** Oracle `@dblink` or 4-part T-SQL names: never resolved. */
  remote?: boolean;
  /** UPDATE/DELETE/INSERT/MERGE target. */
  isTarget?: boolean;
  /** Function call arguments range (table-valued functions). */
  argsRange?: [number, number];
  /** PostgreSQL `fn(...) WITH ORDINALITY`: an extra trailing `ordinality` column. */
  withOrdinality?: boolean;
}

export interface CteDef {
  name: string;
  quoted: boolean;
  nameRange: [number, number];
  columns: string[] | null;
  body: Scope | null;
  recursive: boolean;
}

export interface Projection {
  range: [number, number];
  alias: string | null;
  aliasRange: [number, number] | null;
  aliasQuoted?: boolean;
  /** Bare `col` or `q.col`. */
  colRef: { qualifier: NamePart[]; name: NamePart } | null;
  /** `*` or `q.*`. */
  star: { qualifier: NamePart[] } | null;
  /** T-SQL `SELECT @v = expr` (variable assignment, not an output column). */
  assignment?: boolean;
}

export interface JoinInfo { right: TableRef; onRange: [number, number] | null; kind: string }

export type VarKind = 'var' | 'param' | 'cursor' | 'tableVar' | 'record' | 'exception';

export interface VarDef {
  name: string;
  kind: VarKind;
  type: string;
  range: [number, number];
  /** `t%ROWTYPE` / `c%ROWTYPE` / `:NEW` in triggers. */
  rowtypeOf?: NamePart[];
  /** `t.col%TYPE` */
  typeOf?: NamePart[];
  /** Cursor query / FOR-loop record subquery. */
  query?: Scope;
  /** FOR r IN c LOOP: record of cursor c. */
  recordOfCursor?: string;
  /** DECLARE @t TABLE (...). */
  columns?: ColumnDef[];
  direction?: string;
}

/** Identifier chain in an expression (`c.Name`, `dbo.fnTax(`), recorded for diagnostics/hover. */
export interface Chain { parts: NamePart[]; range: [number, number]; scope: Scope; isCall: boolean }

export interface Scope {
  id: number;
  kind: ScopeKind;
  /** Content range: [start, end]; `end` is the start of the terminating token or Infinity. */
  range: [number, number];
  parent: Scope | null;
  children: Scope[];
  /** Correlated outer scope whose sources are visible (expression subqueries, APPLY/LATERAL). */
  outer: Scope | null;
  /** Second+ branch of a UNION/EXCEPT/INTERSECT (child of the first branch). */
  isBranch?: boolean;
  sources: TableRef[];
  ctes: CteDef[];
  projections: Projection[];
  joins: JoinInfo[];
  targetTable?: TableRef;
  insertColumns?: NamePart[];
  /** Number of items in the first VALUES row (INSERT column-count check). */
  valuesCount?: number;
  valuesRange?: [number, number];
  localVars: Map<string, VarDef>;
  markers: Marker[];
  hasFrom: boolean;
  hasWhere: boolean;
  /** T-SQL SELECT ... INTO #t */
  intoTemp?: NamePart;
  /** First keyword offset (statement kind keyword). */
  start: number;
}

export interface TempTableDef {
  name: string;
  /** The `#t` / `@t` / `t` token range where it is created. */
  defRange: [number, number];
  /** Inline column definitions (CREATE TABLE / DECLARE TABLE) or the INTO query scope. */
  columns?: ColumnDef[];
  fromScope?: Scope;
  kind: 'tempTable' | 'tableVar' | 'table';
  parts?: NamePart[];
  /** Trigger pseudo tables (inserted/deleted): same columns as this table. */
  likeParts?: NamePart[];
}

export interface StatementModel {
  /** Container scope covering the whole statement; holds DECLAREd variables and statement scopes. */
  root: Scope;
  scopes: Scope[];
  tokens: Token[];
  chains: Chain[];
  /** Tables created by this statement (CREATE TABLE, SELECT INTO #t, DECLARE @t TABLE). */
  created: TempTableDef[];
  /** Variables declared at the statement's top level (T-SQL DECLARE; visible to later statements in the batch). */
  declared: VarDef[];
  start: number;
  end: number;
}
