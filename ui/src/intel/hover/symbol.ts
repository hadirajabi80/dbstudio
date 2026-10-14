// Symbol under the cursor: shared by hover (4.9) and go-to-definition (4.10).
import type { Token } from '../types';
import type { DialectSpec, FunctionDef, OperatorDef } from '../dialect/spec';
import type { CatalogIndex, ObjectEntry } from '../catalog/index';
import type { Binder, ResolvedSource } from '../catalog/binder';
import type { ColumnDef, CteDef, NamePart, StatementModel, TempTableDef, VarDef } from '../parse/statement-model';
import { namePart, scopeAt } from '../parse/partial-parser';
import type { CatalogPackageMember } from '../../api/types';

export type SymbolInfo =
  | { kind: 'alias'; src: ResolvedSource; range: [number, number]; isDefinition: boolean }
  | { kind: 'object'; entry: ObjectEntry; synonym: ObjectEntry | null; range: [number, number] }
  | { kind: 'column'; col: ColumnDef; ownerName: string; entry: ObjectEntry | null; range: [number, number]; localDef: [number, number] | null }
  | { kind: 'cte'; cte: CteDef; columns: ColumnDef[]; range: [number, number] }
  | { kind: 'var'; v: VarDef; range: [number, number] }
  | { kind: 'temp'; t: TempTableDef; columns: ColumnDef[]; range: [number, number] }
  | { kind: 'function'; f: FunctionDef; range: [number, number] }
  | { kind: 'member'; pkg: ObjectEntry; members: CatalogPackageMember[]; range: [number, number] }
  | { kind: 'schema'; name: string; count: number; range: [number, number] }
  | { kind: 'operator'; op: OperatorDef; range: [number, number] }
  | { kind: 'sequenceOp'; seq: ObjectEntry; op: string; range: [number, number] };

function isName(t: Token | undefined): boolean {
  return !!t && (t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'quotedIdent' || t.kind === 'param');
}
function isDot(t: Token | undefined): boolean {
  return !!t && t.kind === 'punct' && t.text === '.';
}

export function symbolAt(model: StatementModel, offset: number, binder: Binder, spec: DialectSpec, index: CatalogIndex): SymbolInfo | null {
  const toks = model.tokens;
  let k = toks.findIndex((t) => t.start <= offset && offset < t.end);
  if (k < 0) k = toks.findIndex((t) => t.end === offset);
  if (k < 0) return null;
  const tok = toks[k];
  if (tok.kind === 'op') {
    const op = spec.operators.find((o) => o.op.toUpperCase() === tok.text.toUpperCase());
    return op ? { kind: 'operator', op, range: [tok.start, tok.end] } : null;
  }
  if (!isName(tok)) return null;
  if (tok.kind === 'keyword' && spec.operators.length) {
    const op = spec.operators.find((o) => o.op.toUpperCase() === tok.upper);
    if (op && !spec.functionMap.has(tok.upper)) return { kind: 'operator', op, range: [tok.start, tok.end] };
  }
  // dotted chain around the token
  let a = k, b = k;
  while (a >= 2 && isDot(toks[a - 1]) && isName(toks[a - 2])) a -= 2;
  while (b + 2 < toks.length && isDot(toks[b + 1]) && isName(toks[b + 2])) b += 2;
  const parts: NamePart[] = [];
  for (let i = a; i <= b; i += 2) parts.push(namePart(toks[i]));
  const hi = (k - a) / 2;
  const isCall = !!toks[b + 1] && toks[b + 1].kind === 'punct' && toks[b + 1].text === '(';
  const range: [number, number] = [tok.start, tok.end];
  const scope = scopeAt(model, toks[a].start);
  const me = parts[hi];

  if (hi === 0) {
    // alias / table name inside a FROM clause
    for (const s of model.scopes) {
      for (const ref of s.sources) {
        if (ref.aliasRange && ref.aliasRange[0] <= offset && offset < ref.aliasRange[1] + (offset === ref.aliasRange[1] ? 1 : 0)) {
          return { kind: 'alias', src: binder.source(ref, s), range: ref.aliasRange, isDefinition: true };
        }
        if (parts.length === 1 || hi === parts.length - 1 || ref.parts.length > 1) {
          if (ref.nameRange[0] <= tok.start && tok.end <= ref.nameRange[1] && ref.kind !== 'subquery') {
            const src = binder.source(ref, s);
            const lastPart = ref.parts[ref.parts.length - 1];
            if (lastPart && lastPart.range[0] === tok.start) return sourceSymbol(src, range, binder);
          }
        }
      }
      if (s.targetTable && s.targetTable.nameRange[0] <= tok.start && tok.end <= s.targetTable.nameRange[1]) {
        const lastPart = s.targetTable.parts[s.targetTable.parts.length - 1];
        if (lastPart && lastPart.range[0] === tok.start) return sourceSymbol(binder.target(s) ?? binder.source(s.targetTable, s), range, binder);
      }
      for (const cte of s.ctes) if (cte.nameRange[0] === tok.start) return { kind: 'cte', cte, columns: binder.cteColumns(cte), range };
    }
    if (parts.length === 1 || hi < parts.length - 1) {
      if (isCall && parts.length === 1) {
        const r = index.resolve(parts, (e) => e.type === 'func' || e.type === 'proc' || e.type === 'tablefunc');
        if (r) return { kind: 'object', entry: r, synonym: null, range };
        const f = spec.functionMap.get(me.text.toUpperCase());
        if (f) return { kind: 'function', f, range };
      }
      const src = binder.findSourceByLabel(me, scope);
      if (src) return { kind: 'alias', src: src.src, range, isDefinition: false };
      const cte = binder.findCte(me, scope);
      if (cte) return { kind: 'cte', cte, columns: binder.cteColumns(cte), range };
      const v = binder.findVar(me.text, scope);
      if (v) return { kind: 'var', v, range };
      if (parts.length === 1) {
        for (const vs of binder.visibleSources(scope)) {
          const col = vs.src.columns().find((c) => index.keyOfCatalog(c.name) === index.keyOf(me.text, me.quoted) || c.name.toUpperCase() === me.text.toUpperCase());
          if (col) return { kind: 'column', col, ownerName: vs.src.display, entry: vs.src.entry, range, localDef: vs.src.entry ? null : col.defRange ?? null };
        }
        const f = spec.functionMap.get(me.text.toUpperCase());
        if (f && (f.kind === 'global' || f.kind === 'niladic')) return { kind: 'function', f, range };
      }
      const t = binder.symbols.tables.get(me.text.toUpperCase());
      if (t) return { kind: 'temp', t, columns: binder.tempColumns(t), range };
      const obj = index.resolveRaw([me], () => true);
      if (obj) return { kind: 'object', entry: obj.type === 'synonym' ? index.followSynonym(obj) ?? obj : obj, synonym: obj.type === 'synonym' ? obj : null, range };
      const sch = index.schema(me.text, me.quoted);
      if (sch) return { kind: 'schema', name: sch.name, count: sch.objects.length, range };
      const bi = index.builtin(me);
      if (bi) return { kind: 'object', entry: bi, synonym: null, range };
      return null;
    }
  }
  // qualified part: resolve the qualifier
  const q = parts.slice(0, hi);
  if (!q.length) return null;
  const target = binder.resolveQualifier(q, scope);
  if (!target) return null;
  switch (target.kind) {
    case 'source': case 'record': case 'object': {
      const cols = target.kind === 'source' ? target.src.columns() : target.kind === 'record' ? target.columns : target.entry.columns();
      const col = cols.find((c) => index.keyOfCatalog(c.name) === index.keyOf(me.text, me.quoted) || c.name.toUpperCase() === me.text.toUpperCase());
      if (target.kind === 'object' && hi === parts.length - 1 && !col) return null;
      if (!col) return null;
      const entry = target.kind === 'source' ? target.src.entry : target.kind === 'object' ? target.entry : null;
      const ownerName = target.kind === 'source' ? target.src.display : target.kind === 'record' ? target.name : target.entry.qualifiedName;
      return { kind: 'column', col, ownerName, entry, range, localDef: entry ? null : col.defRange ?? null };
    }
    case 'schema': {
      const e = index.resolve([...q, me], () => true, false);
      if (e) return { kind: 'object', entry: e.type === 'synonym' ? index.followSynonym(e) ?? e : e, synonym: e.type === 'synonym' ? e : null, range };
      return null;
    }
    case 'package': {
      const members = target.entry.members().filter((m) => m.n.toUpperCase() === me.text.toUpperCase());
      return members.length ? { kind: 'member', pkg: target.entry, members, range } : null;
    }
    case 'sequence':
      return { kind: 'sequenceOp', seq: target.entry, op: me.text.toUpperCase(), range };
    case 'database': {
      const sch = index.schema(me.text, me.quoted);
      return sch ? { kind: 'schema', name: sch.name, count: sch.objects.length, range } : null;
    }
  }
  return null;
}

function sourceSymbol(src: ResolvedSource, range: [number, number], binder: Binder): SymbolInfo | null {
  if (src.cte) return { kind: 'cte', cte: src.cte, columns: binder.cteColumns(src.cte), range };
  if (src.temp) return { kind: 'temp', t: src.temp, columns: binder.tempColumns(src.temp), range };
  if (src.variable) return { kind: 'var', v: src.variable, range };
  if (src.entry) return { kind: 'object', entry: src.entry, synonym: src.synonym, range };
  if (src.synonym) return { kind: 'object', entry: src.synonym, synonym: null, range };
  return null;
}
