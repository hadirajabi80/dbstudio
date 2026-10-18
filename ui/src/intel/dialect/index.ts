import type { Dialect } from '../types';
import type { DialectSpec } from './spec';
import { tsqlSpec } from './tsql';
import { plsqlSpec } from './plsql';
import { sqliteSpec } from './sqlite';

export type { DialectSpec, FunctionDef, PackageDef, PackageMemberDef, FunctionSignature, SnippetDef } from './spec';

export function getSpec(dialect: Dialect): DialectSpec {
  switch (dialect) {
    case 'tsql': return tsqlSpec;
    case 'plsql': return plsqlSpec;
    case 'sqlite': return sqliteSpec;
    case 'pgsql': return sqliteSpec; // M2-0 placeholder: PG-B adds pgsqlSpec
  }
}

export { tsqlSpec, plsqlSpec, sqliteSpec };
