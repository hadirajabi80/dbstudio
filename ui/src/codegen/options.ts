// Code generation options, defaults and the language × flavor catalogue shown in the panel.
// Persisted under Settings.ui.codegen.
import type { Dialect } from '../api/types';
import type { NamingStyle } from './naming';

export type CgLanguage = 'csharp' | 'go' | 'typescript' | 'java' | 'python' | 'sql' | 'json';

export interface IncludeOptions {
  /** Entity / struct / interface / dataclass. */
  model: boolean;
  /** Data access: repository with CRUD, query functions. */
  repository: boolean;
  /** Procedure / function / package call wrappers. */
  procedures: boolean;
  /** C# repository interface, Go/TS/Java interface for the repository. */
  interface: boolean;
}

export interface CodegenOptions {
  language: CgLanguage;
  flavor: string;
  /** Member (property/field) naming. `null` = the language's idiomatic default. */
  naming: NamingStyle | null;
  singularize: boolean;
  /** `Status, Data=Datum` (see naming.singularWord). */
  singularExceptions: string;
  /** C# namespace, Java package, Go package, Python module docstring. */
  namespace: string;
  include: IncludeOptions;
  /** One file for everything (true) or one file per object (false). */
  combined: boolean;

  // C#
  nullableReferenceTypes: boolean;
  dataAnnotations: boolean;
  records: boolean;
  /** `required` modifier instead of `= ""` initialisers for non-null reference properties. */
  requiredMembers: boolean;
  dateOnly: boolean;

  // Go
  goNullable: 'pointer' | 'sqlNull';
  goDecimal: 'float64' | 'string';
  /** Emit `json:"..."` struct tags. */
  goJsonTags: boolean;

  // TypeScript
  tsNullable: 'union' | 'optional';
  tsDate: 'string' | 'Date';
  tsDecimal: 'number' | 'string';
  tsBigint: 'number' | 'string' | 'bigint';

  // Java
  javaRecords: boolean;

  // Python
  pyUnionSyntax: boolean;

  // Oracle
  numberOneAsBool: boolean;
}

export const DEFAULT_OPTIONS: CodegenOptions = {
  language: 'csharp',
  flavor: 'dapper',
  naming: null,
  singularize: true,
  singularExceptions: '',
  namespace: 'App.Data',
  include: { model: true, repository: true, procedures: true, interface: false },
  combined: true,
  nullableReferenceTypes: true,
  dataAnnotations: true,
  records: false,
  requiredMembers: false,
  dateOnly: true,
  goNullable: 'pointer',
  goDecimal: 'float64',
  goJsonTags: true,
  tsNullable: 'union',
  tsDate: 'string',
  tsDecimal: 'number',
  tsBigint: 'number',
  javaRecords: true,
  pyUnionSyntax: true,
  numberOneAsBool: false,
};

export interface FlavorInfo {
  id: string;
  label: string;
  /** Dialects the flavor supports (undefined = all). */
  dialects?: Dialect[];
  description: string;
}

export interface LanguageInfo {
  id: CgLanguage;
  label: string;
  /** Monaco language id of the output. */
  monaco: string;
  extension: string;
  flavors: FlavorInfo[];
  /** Member naming styles offered, first = default. */
  naming: NamingStyle[];
  /** Default namespace / package text. */
  namespacePlaceholder: string;
  namespaceLabel: string | null;
}

export const LANGUAGES: LanguageInfo[] = [
  {
    id: 'csharp', label: 'C#', monaco: 'csharp', extension: 'cs', naming: ['pascal', 'asIs'], namespacePlaceholder: 'App.Data', namespaceLabel: 'Namespace',
    flavors: [
      { id: 'dapper', label: 'Dapper', description: 'POCO + Dapper repository, procedure wrappers with DynamicParameters' },
      { id: 'efcore', label: 'EF Core', description: 'Entity + IEntityTypeConfiguration (keys, lengths, FKs, table) + DbContext' },
      { id: 'adonet', label: 'ADO.NET', description: 'Raw SqlClient / ODP.NET / Microsoft.Data.Sqlite with explicit mapping' },
      { id: 'model', label: 'Model only', description: 'Classes or records only' },
    ],
  },
  {
    id: 'go', label: 'Go', monaco: 'go', extension: 'go', naming: ['pascal', 'asIs'], namespacePlaceholder: 'store', namespaceLabel: 'Package',
    flavors: [
      { id: 'database-sql', label: 'database/sql', description: 'Structs with db tags, CRUD with context.Context and explicit Scan' },
      { id: 'sqlx', label: 'sqlx', description: 'Structs with db tags, sqlx Get/Select/NamedExec' },
    ],
  },
  {
    id: 'typescript', label: 'TypeScript', monaco: 'typescript', extension: 'ts', naming: ['camel', 'asIs', 'snake'], namespacePlaceholder: '', namespaceLabel: null,
    flavors: [
      { id: 'interface', label: 'Interfaces', description: 'DTO interfaces for React / Angular / Node' },
      { id: 'driver', label: 'Node driver', description: 'Typed data access with node-mssql, node-oracledb or better-sqlite3 (by connection)' },
      { id: 'zod', label: 'Zod schema', description: 'Zod schemas with inferred types for API validation' },
    ],
  },
  {
    id: 'java', label: 'Java', monaco: 'java', extension: 'java', naming: ['camel', 'asIs'], namespacePlaceholder: 'com.example.data', namespaceLabel: 'Package',
    flavors: [
      { id: 'jdbc', label: 'JDBC', description: 'Records/classes, RowMapper, PreparedStatement CRUD, CallableStatement wrappers' },
      { id: 'jpa', label: 'JPA', description: 'Jakarta Persistence @Entity classes with @Id/@Column/@Table' },
    ],
  },
  {
    id: 'python', label: 'Python', monaco: 'python', extension: 'py', naming: ['snake', 'asIs'], namespacePlaceholder: '', namespaceLabel: null,
    flavors: [
      { id: 'dataclass', label: 'dataclass + driver', description: 'Dataclasses with typed functions for pyodbc / oracledb / sqlite3 (by connection)' },
      { id: 'sqlalchemy', label: 'SQLAlchemy 2.0', description: 'Declarative models with Mapped[] annotations' },
      { id: 'pydantic', label: 'Pydantic', description: 'Pydantic v2 models' },
    ],
  },
  {
    id: 'sql', label: 'SQL', monaco: 'sql', extension: 'sql', naming: ['asIs'], namespacePlaceholder: '', namespaceLabel: null,
    flavors: [
      { id: 'all', label: 'All statements', description: 'SELECT, INSERT, UPDATE, DELETE, MERGE and EXEC templates' },
      { id: 'select', label: 'SELECT', description: 'SELECT with all columns' },
      { id: 'insert', label: 'INSERT', description: 'INSERT with all writable columns' },
      { id: 'update', label: 'UPDATE', description: 'UPDATE by primary key' },
      { id: 'delete', label: 'DELETE', description: 'DELETE by primary key' },
      { id: 'merge', label: 'MERGE', dialects: ['tsql', 'plsql'], description: 'Upsert by primary key' },
      { id: 'exec', label: 'EXEC / call', dialects: ['tsql', 'plsql'], description: 'Procedure call with named parameters' },
    ],
  },
  {
    id: 'json', label: 'JSON', monaco: 'json', extension: 'json', naming: ['camel', 'asIs', 'snake', 'pascal'], namespacePlaceholder: '', namespaceLabel: null,
    flavors: [
      { id: 'sample', label: 'Sample object', description: 'One row with type-appropriate placeholder values' },
      { id: 'json-schema', label: 'JSON Schema', description: 'Draft 2020-12 schema' },
    ],
  },
];

export function languageInfo(id: CgLanguage): LanguageInfo {
  return LANGUAGES.find((l) => l.id === id) ?? LANGUAGES[0];
}

export function flavorsFor(id: CgLanguage, dialect: Dialect): FlavorInfo[] {
  return languageInfo(id).flavors.filter((f) => !f.dialects || f.dialects.includes(dialect));
}

/** Effective member naming style. */
export function memberNaming(o: CodegenOptions): NamingStyle {
  const info = languageInfo(o.language);
  return o.naming && info.naming.includes(o.naming) ? o.naming : info.naming[0];
}

/** Merge persisted (possibly partial or stale) options over the defaults. */
export function normalizeOptions(p: Partial<CodegenOptions> | null | undefined): CodegenOptions {
  const o: CodegenOptions = { ...DEFAULT_OPTIONS, ...(p ?? {}), include: { ...DEFAULT_OPTIONS.include, ...(p?.include ?? {}) } };
  const info = languageInfo(o.language);
  if (!info.flavors.some((f) => f.id === o.flavor)) o.flavor = info.flavors[0].id;
  return o;
}

/** Switching language picks that language's default flavor and naming. */
export function withLanguage(o: CodegenOptions, language: CgLanguage): CodegenOptions {
  const info = languageInfo(language);
  return { ...o, language, flavor: info.flavors[0].id, naming: null, namespace: o.language === language ? o.namespace : info.namespacePlaceholder };
}
