// Naming of generated types and members, shared by the language generators so every language agrees on
// singularisation, collision handling and reserved-word escaping.
import type { Dialect } from '../api/types';
import type { CgColumn, CgObject, CgParam, CgRoutine } from './model';
import {
  applyStyle, camel, escapeIdent, goCamel, goPascal, NameScope, pascal, singularize, snake, type NamingStyle, type TargetLang,
} from './naming';
import type { CodegenOptions } from './options';
import { memberNaming } from './options';
import { resolveType, type ResolvedType } from './types';

export interface Member {
  col: CgColumn;
  /** Property / field name in the target language (already escaped). */
  name: string;
  type: ResolvedType;
  nullable: boolean;
}

export function targetLang(o: CodegenOptions): TargetLang {
  return o.language === 'sql' || o.language === 'json' ? 'typescript' : o.language;
}

/** Type name for a table/view/query: `Customers` → `Customer`, `ORDER_LINES` → `OrderLine`. */
export function typeNameOf(name: string, o: CodegenOptions, singular = true): string {
  const base = singular && o.singularize ? singularize(name, { exceptions: o.singularExceptions }) : name;
  const n = o.language === 'go' ? goPascal(base) : pascal(base);
  return escapeIdent(targetLang(o), n);
}

function memberName(col: string, style: NamingStyle, lang: TargetLang): string {
  if (lang === 'go') return style === 'asIs' ? capitalize(asIsIdent(col)) : goPascal(col);
  return applyStyle(col, style);
}

const asIsIdent = (s: string) => applyStyle(s, 'asIs');
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Members of a model type, unique within the type and never equal to the enclosing type name. */
export function membersOf(columns: CgColumn[], dialect: Dialect, o: CodegenOptions, enclosing: string): Member[] {
  const lang = targetLang(o);
  const style = memberNaming(o);
  const scope = new NameScope([enclosing], lang === 'csharp' || lang === 'go');
  return columns.map((col) => {
    let n = memberName(col.name, style, lang);
    if (lang === 'csharp' && n === enclosing) n = `${n}1`;
    n = scope.take(n);
    return {
      col,
      name: escapeIdent(lang, n),
      type: resolveType(dialect, col.dbType, { kind: col.kind, numberOneAsBool: o.numberOneAsBool, enumLabels: col.enumLabels, domainBase: col.domainBase }),
      nullable: col.nullable,
    };
  });
}

/** Drop Oracle-style direction prefixes: `P_CUSTOMER_ID` → `CUSTOMER_ID`, `p_orders` → `orders`. */
export function friendlyParam(name: string): string {
  const m = /^(p|pi|po|pio|i|o|io|in|out|v|arg)_(.+)$/i.exec(name.replace(/^[@:]/, ''));
  return m && /^[A-Za-z]/.test(m[2]) ? m[2] : name.replace(/^[@:]/, '');
}

/** Local variable / parameter name in the target language (`@CustomerId` → `customerId`, `P_CUST` → `cust`). */
export function localName(name: string, o: CodegenOptions): string {
  const lang = targetLang(o);
  name = friendlyParam(name);
  const n = lang === 'python' ? snake(name) : lang === 'go' ? goCamel(name) : camel(name);
  return escapeIdent(lang, n);
}

/** Method/function name for a routine or query (`GetCustomer` → C# `GetCustomerAsync`, Go `GetCustomer`, Python `get_customer`). */
export function routineFnName(name: string, o: CodegenOptions): string {
  const lang = targetLang(o);
  switch (lang) {
    case 'csharp':
      return `${pascal(name)}Async`;
    case 'go':
      return goPascal(name);
    case 'python':
      return escapeIdent(lang, snake(name));
    default:
      return escapeIdent(lang, camel(name));
  }
}

/** Name of the bind parameter for a routine parameter: `@Id` → `Id`, `P_CUST` → `P_CUST`. */
export function bindNameOf(p: CgParam): string {
  return p.name.replace(/^[@:]/, '');
}

/** Container name for standalone routines of a schema: `dbo` → `DboProcedures`. */
export function proceduresClassName(schema: string | null, o: CodegenOptions): string {
  const base = schema ? `${schema}_procedures` : 'procedures';
  return o.language === 'go' ? goPascal(base) : pascal(base);
}

/** Qualified routine name for calls: `dbo.GetCustomer`, `SHOP.ORDER_API.CREATE_ORDER`. */
export function routineSqlName(r: CgRoutine, dialect: Dialect, quote: (s: string, d: Dialect) => string): string {
  const parts = [r.schema, r.package, r.name].filter((x): x is string => !!x && !(dialect === 'sqlite' && x === 'main'));
  return parts.map((p) => quote(p, dialect)).join('.');
}

/** Stable sort key and label for an object (used for file names and headers). */
export function objectLabel(obj: CgObject): string {
  if (obj.kind === 'query') return obj.name;
  if (obj.kind === 'package') return [obj.schema, obj.name].filter(Boolean).join('.');
  if (obj.kind === 'proc' || obj.kind === 'func') return [obj.schema, obj.package, obj.name].filter(Boolean).join('.');
  return [obj.schema, obj.name].filter(Boolean).join('.');
}

export const DIALECT_LABEL: Record<Dialect, string> = {
  tsql: 'SQL Server', plsql: 'Oracle', sqlite: 'SQLite', pgsql: 'PostgreSQL',
  mysql: 'MySQL', clickhouse: 'ClickHouse', snowflake: 'Snowflake', cql: 'Cassandra',
};

/** Primary key members in key order. */
export function pkMembers(members: Member[], pk: string[]): Member[] {
  return pk.map((n) => members.find((m) => m.col.name === n)).filter((m): m is Member => !!m);
}
