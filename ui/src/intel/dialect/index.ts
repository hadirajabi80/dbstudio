import type { Dialect } from '../types';
import type { DialectSpec } from './spec';
import { tsqlSpec } from './tsql';
import { plsqlSpec } from './plsql';
import { sqliteSpec } from './sqlite';
import { pgsqlSpec } from './pgsql';

export type { DialectSpec, FunctionDef, PackageDef, PackageMemberDef, FunctionSignature, SnippetDef, CaseFolding } from './spec';

export function getSpec(dialect: Dialect): DialectSpec {
  switch (dialect) {
    case 'tsql': return tsqlSpec;
    case 'plsql': return plsqlSpec;
    case 'sqlite': return sqliteSpec;
    case 'pgsql': return pgsqlSpec;
  }
}

export { tsqlSpec, plsqlSpec, sqliteSpec, pgsqlSpec };
