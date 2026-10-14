// Go-to-definition (PLAN 4.10).
import type { DefinitionResult } from '../types';
import type { CatalogIndex } from '../catalog/index';
import type { SymbolInfo } from '../hover/symbol';

export function definitionFor(sym: SymbolInfo, index: CatalogIndex): DefinitionResult | null {
  switch (sym.kind) {
    case 'alias': {
      const r = sym.src.ref.aliasRange;
      if (r) return { kind: 'local', range: r };
      return null;
    }
    case 'cte': return { kind: 'local', range: sym.cte.nameRange };
    case 'var': return { kind: 'local', range: sym.v.range };
    case 'temp': return { kind: 'local', range: sym.t.defRange };
    case 'object': {
      if (sym.entry.builtin) return null;
      return { kind: 'object', ref: { database: index.database, schema: sym.entry.schema, name: sym.entry.name, type: sym.entry.type } };
    }
    case 'column': {
      if (sym.entry) return { kind: 'object', ref: { database: index.database, schema: sym.entry.schema, name: sym.entry.name, type: sym.entry.type }, column: sym.col.name };
      if (sym.localDef) return { kind: 'local', range: sym.localDef };
      return null;
    }
    case 'member': return { kind: 'object', ref: { database: index.database, schema: sym.pkg.schema, name: sym.pkg.name, type: 'package' } };
    case 'sequenceOp': return { kind: 'object', ref: { database: index.database, schema: sym.seq.schema, name: sym.seq.name, type: 'sequence' } };
    default: return null;
  }
}
