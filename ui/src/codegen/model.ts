// Input model of the code generators (docs/PLAN-M1.5.md section 1.4). Built from the catalog snapshot,
// /catalog/object details or a described result set; generators never talk to the network.
import type { ColumnKind, Dialect } from '../api/types';

export interface CgColumn {
  name: string;
  /** Database type text as reported (`nvarchar(100)`, `NUMBER(12,2)`, `INTEGER`). */
  dbType: string;
  nullable: boolean;
  pk: boolean;
  identity: boolean;
  computed: boolean;
  /** Column has a server default (excluded from nothing, but noted in docs). */
  hasDefault?: boolean;
  comment?: string | null;
  /** Wire kind (query columns from ColumnInfo); used when the type text is not in the mapping table. */
  kind?: ColumnKind;
}

export interface CgForeignKey {
  name: string;
  columns: string[];
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
}

export interface CgTable {
  kind: 'table' | 'view';
  schema: string | null;
  name: string;
  comment?: string | null;
  columns: CgColumn[];
  primaryKey: string[];
  foreignKeys: CgForeignKey[];
}

export type ParamDirection = 'in' | 'out' | 'inout' | 'return';

export interface CgParam {
  /** As in the catalog: `@Id` (T-SQL), `P_CUST` (Oracle); empty for a function return value. */
  name: string;
  dbType: string;
  direction: ParamDirection;
  hasDefault: boolean;
}

export interface CgRoutine {
  kind: 'proc' | 'func';
  schema: string | null;
  /** Oracle package that owns this member. */
  package: string | null;
  name: string;
  /** Parameters in declaration order; a function's return value has direction `return`. */
  params: CgParam[];
  /** Result set shape when known ("Run to infer result columns"); null = unknown. */
  resultColumns: CgColumn[] | null;
  /** Oracle overload number (1 when not overloaded). */
  overload?: number;
}

export interface CgPackage {
  kind: 'package';
  schema: string | null;
  name: string;
  members: CgRoutine[];
}

/** Driver-neutral parameter type for query parameters (same names as ExecuteRequest.params kinds). */
export type QueryParamType =
  | 'string' | 'int' | 'long' | 'decimal' | 'float' | 'bool' | 'date' | 'datetime' | 'datetimeoffset' | 'time' | 'guid' | 'binary';

export interface CgQueryParam {
  /** Name without prefix (`id`); positional `?` parameters get `p1`, `p2`, ... */
  name: string;
  type: QueryParamType;
  /** Positional `?` in the source SQL. */
  positional: boolean;
}

export interface CgQuery {
  kind: 'query';
  /** Base name for the generated DTO / function (`CustomerOrders`). */
  name: string;
  /** SQL text as written by the user (parameter tokens in the dialect's own syntax). */
  sql: string;
  params: CgQueryParam[];
  columns: CgColumn[];
}

export type CgObject = CgTable | CgRoutine | CgPackage | CgQuery;

export interface CgInput {
  dialect: Dialect;
  objects: CgObject[];
}

export interface GeneratedFile {
  /** Suggested file name (`Customer.cs`, `customers.go`). */
  path: string;
  /** Monaco language id for the preview. */
  language: string;
  content: string;
}

export const isTable = (o: CgObject): o is CgTable => o.kind === 'table' || o.kind === 'view';
export const isRoutine = (o: CgObject): o is CgRoutine => o.kind === 'proc' || o.kind === 'func';

/** The routine's return value parameter, if any. */
export function returnParam(r: CgRoutine): CgParam | undefined {
  return r.params.find((p) => p.direction === 'return');
}

/** Parameters the caller passes (everything except the function return value). */
export function callParams(r: CgRoutine): CgParam[] {
  return r.params.filter((p) => p.direction !== 'return');
}

export function isRefCursor(dbType: string): boolean {
  return /^(sys_refcursor|ref\s+cursor|refcursor)$/i.test(dbType.trim());
}
