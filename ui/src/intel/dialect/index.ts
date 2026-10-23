import type { Dialect } from '../types';
import type { DialectSpec } from './spec';
import { tsqlSpec } from './tsql';
import { plsqlSpec } from './plsql';
import { sqliteSpec } from './sqlite';
import { pgsqlSpec } from './pgsql';
import { genericSpec, loadedSpec } from './registry';

export type {
  DialectSpec, FunctionDef, PackageDef, PackageMemberDef, FunctionSignature, SnippetDef, CaseFolding, LexTraits, DialectSplitter,
  SystemCatalogJson, SplitKit, FormatKit, FormatRulesFactory, DialectKit, DialectDefine, SpecInit,
} from './spec';

/**
 * Spec of a dialect. The four original dialects are static; the Batch 3 ones (mysql, clickhouse, snowflake, cql) load on
 * demand (dialect/registry.ts ensureDialect) and answer with the generic stand-in (dialect/generic.ts) until then.
 */
export function getSpec(dialect: Dialect): DialectSpec {
  switch (dialect) {
    case 'tsql': return tsqlSpec;
    case 'plsql': return plsqlSpec;
    case 'sqlite': return sqliteSpec;
    case 'pgsql': return pgsqlSpec;
    default: return loadedSpec(dialect) ?? genericSpec(dialect);
  }
}

export { tsqlSpec, plsqlSpec, sqliteSpec, pgsqlSpec };
export { ensureDialect, isDialectReady, isLazyDialect } from './registry';
