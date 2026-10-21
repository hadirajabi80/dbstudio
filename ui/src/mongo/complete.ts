// Query-bar and pipeline completion (docs/PLAN-M2.md 6.3): finds where the caret is in shell JSON (a key or a value,
// inside which fields/operators) and proposes field paths (from `POST …/fields`), operators, sampled values and
// value helpers. Framework-free; the Monaco provider in components/Mongo/language.ts maps these to completion items.
import type { MongoFieldPath } from '../api/types';
import { parseEjson, scalarShell, typeAliasLabel } from './bson';
import {
  ACCUMULATORS, EXPRESSIONS, QUERY_OPERATORS, STAGES, TOP_LEVEL_QUERY_OPERATORS, TYPE_ALIASES, VALUE_HELPERS, type OperatorDoc,
} from './operators';
import { tokenize, type Token } from './shellJson';

/** What the edited text is: drives which suggestions make sense. */
export type CompletionMode = 'filter' | 'projection' | 'sort' | 'collation' | 'document' | `stage:${string}`;

export interface CaretContext {
  /** key: typing a field name / operator; value: typing a value; none: nowhere useful (after a value, in a comment). */
  where: 'key' | 'value' | 'none';
  /** Keys of the enclosing containers, outermost first, ending with the key whose value is being typed. */
  keys: string[];
  /** The partial word under the caret (without quotes). */
  prefix: string;
  /** Offset where the partial word (incl. an opening quote) starts. */
  start: number;
  /** The caret is inside an open string literal (quote char). */
  quote: string | null;
}

const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', '-Infinity', 'MinKey', 'MaxKey']);

interface Frame {
  kind: 'obj' | 'arr' | 'call';
  owner: string | null;
  state: 'key' | 'colon' | 'value' | 'after';
  cur: string | null;
}

/** Caret context of `text` at `offset`. */
export function caretContext(text: string, offset: number): CaretContext {
  const before = text.slice(0, offset);
  const toks = tokenize(before).filter((t) => t.kind !== 'eof');
  let partial: Token | null = null;
  const last = toks[toks.length - 1];
  if (last && last.end === offset && (last.kind === 'ident' || last.kind === 'number' || (last.kind === 'string' && last.open))) {
    partial = last;
    toks.pop();
  }
  const stack: Frame[] = [];
  const firstSig = toks[0] ?? partial;
  // bare `field: value` text (no braces) behaves like the inside of a document
  if (!firstSig || firstSig.kind === 'ident') {
    stack.push({ kind: 'obj', owner: null, state: 'key', cur: null });
  }
  const top = () => stack[stack.length - 1];
  const ownerForChild = (): string | null => {
    const t = top();
    if (!t) return null;
    if (t.kind === 'obj') return t.cur;
    return t.owner;
  };
  for (const tk of toks) {
    const t = top();
    if (tk.kind === 'punct') {
      switch (tk.value) {
        case '{': stack.push({ kind: 'obj', owner: ownerForChild(), state: 'key', cur: null }); break;
        case '[': stack.push({ kind: 'arr', owner: ownerForChild(), state: 'value', cur: null }); break;
        case '(': stack.push({ kind: 'call', owner: ownerForChild(), state: 'value', cur: null }); break;
        case '}': case ']': case ')': {
          stack.pop();
          const p = top();
          if (p && p.kind === 'obj') p.state = 'after';
          break;
        }
        case ':': if (t && t.kind === 'obj' && t.state === 'colon') t.state = 'value'; break;
        case ',': if (t && t.kind === 'obj') { t.state = 'key'; t.cur = null; } break;
      }
      continue;
    }
    if (!t) continue;
    if (t.kind === 'obj') {
      if (t.state === 'key') {
        t.cur = tk.value;
        t.state = 'colon';
      } else if (t.state === 'value') {
        // `new Date(` style helpers: an identifier followed by '(' keeps the value state until the call closes
        t.state = tk.kind === 'ident' && !LITERALS.has(tk.value) ? 'value' : 'after';
      }
    }
  }
  const t = top();
  const keys: string[] = [];
  for (const f of stack) {
    if (f.kind === 'obj' && f.owner !== null && keys[keys.length - 1] !== f.owner) keys.push(f.owner);
    else if (f.kind === 'arr' && f.owner !== null && keys[keys.length - 1] !== f.owner) keys.push(f.owner);
  }
  const prefix = partial ? partial.value : '';
  const start = partial ? partial.start : offset;
  const quote = partial?.kind === 'string' ? partial.quote ?? '"' : null;
  if (!t) return { where: stack.length === 0 && toks.length === 0 ? 'value' : 'none', keys, prefix, start, quote };
  if (t.kind === 'obj') {
    if (t.state === 'key') return { where: 'key', keys, prefix, start, quote };
    if (t.state === 'value') return { where: 'value', keys: t.cur !== null ? [...keys, t.cur] : keys, prefix, start, quote };
    return { where: 'none', keys, prefix, start, quote };
  }
  if (t.kind === 'arr') return { where: 'value', keys, prefix, start, quote };
  return { where: 'none', keys, prefix, start, quote };
}

export type SuggestionKind = 'field' | 'operator' | 'stage' | 'value' | 'helper' | 'keyword';

export interface Suggestion {
  label: string;
  /** Text inserted in place of the prefix (Monaco snippet syntax when `snippet`). */
  insert: string;
  snippet?: boolean;
  kind: SuggestionKind;
  detail?: string;
  doc?: string;
  /** Lower sorts first. */
  rank: number;
}

const LOGICAL = new Set(['$and', '$or', '$nor']);
const COMPARE = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$all']);

/** Field path built from the non-operator keys (`address.city`, `items.sku` inside $elemMatch). */
export function fieldPathOf(keys: readonly string[]): string {
  return keys.filter((k) => !k.startsWith('$') && !/^\d+$/.test(k)).join('.');
}

function opSuggestion(o: OperatorDoc, rank: number, quote: string | null): Suggestion {
  if (quote) return { label: o.name, insert: o.name, kind: 'operator', detail: o.syntax, doc: o.summary, rank };
  return { label: o.name, insert: `\\${o.name}: ${o.snippet ?? '${1}'}`, snippet: true, kind: 'operator', detail: o.syntax, doc: o.summary, rank };
}

function keyText(name: string, quote: string | null): string {
  if (quote) return name;
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function fieldSuggestions(fields: readonly MongoFieldPath[], base: string, quote: string | null, rank: number): Suggestion[] {
  const out: Suggestion[] = [];
  const pre = base ? `${base}.` : '';
  for (const f of fields) {
    if (pre && !f.path.startsWith(pre)) continue;
    const rel = f.path.slice(pre.length);
    if (!rel) continue;
    out.push({
      label: rel, insert: keyText(rel, quote), kind: 'field', detail: f.types.map(typeAliasLabel).join(' | '),
      rank: rank + rel.split('.').length - 1,
    });
  }
  return out;
}

function refSuggestions(fields: readonly MongoFieldPath[], quote: string | null, rank: number): Suggestion[] {
  return fields.map((f) => ({
    label: `$${f.path}`, insert: quote ? `$${f.path}` : JSON.stringify(`$${f.path}`), kind: 'field' as const,
    detail: f.types.map(typeAliasLabel).join(' | '), rank: rank + f.path.split('.').length - 1,
  }));
}

function valueSuggestions(field: MongoFieldPath | undefined, quote: string | null): Suggestion[] {
  const out: Suggestion[] = [];
  if (field?.values) {
    for (const raw of field.values) {
      try {
        const v = parseEjson(raw);
        const text = scalarShell(v);
        if (quote && v.t === 'string') out.push({ label: v.v, insert: v.v, kind: 'value', detail: field.path, rank: 0 });
        else if (!quote) out.push({ label: text, insert: text, kind: 'value', detail: field.path, rank: 0 });
      } catch {
        /* skip */
      }
    }
  }
  if (!quote) {
    const types = new Set(field?.types ?? []);
    for (const h of VALUE_HELPERS) {
      const relevant = h.types.some((ty) => types.has(ty));
      out.push({ label: h.label, insert: h.snippet, snippet: true, kind: 'helper', detail: h.detail, rank: relevant ? 1 : 5 });
    }
    if (types.has('bool')) for (const b of ['true', 'false']) out.push({ label: b, insert: b, kind: 'keyword', rank: 0 });
    out.push({ label: 'null', insert: 'null', kind: 'keyword', rank: 6 });
  }
  return out;
}

function stageName(mode: CompletionMode): string | null {
  return mode.startsWith('stage:') ? mode.slice(6) : null;
}

/** Suggestions for the caret context. `fields` comes from the fields endpoint (may be empty while loading). */
export function suggest(mode: CompletionMode, ctx: CaretContext, fields: readonly MongoFieldPath[]): Suggestion[] {
  const out = suggestRaw(mode, ctx, fields);
  const p = ctx.prefix.toLowerCase();
  const filtered = p ? out.filter((s) => s.label.toLowerCase().includes(p.replace(/^["']/, ''))) : out;
  return filtered.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function suggestRaw(mode: CompletionMode, ctx: CaretContext, fields: readonly MongoFieldPath[]): Suggestion[] {
  const stage = stageName(mode);
  if (stage === '$match') return suggestRaw('filter', ctx, fields);
  const byPath = new Map(fields.map((f) => [f.path, f]));
  const owner = ctx.keys[ctx.keys.length - 1] ?? null;
  const quote = ctx.quote;

  // "$field" references inside strings (aggregation expressions, $group _id, $unwind...)
  if (ctx.where === 'value' && quote && ctx.prefix.startsWith('$')) return refSuggestions(fields, quote, 0);

  if (mode === 'filter') {
    if (ctx.where === 'key') {
      if (owner === null || LOGICAL.has(owner)) {
        return [...fieldSuggestions(fields, '', quote, 0), ...TOP_LEVEL_QUERY_OPERATORS.map((o) => opSuggestion(o, 10, quote))];
      }
      if (owner === '$expr' || ctx.keys.includes('$expr')) return EXPRESSIONS.map((o) => opSuggestion(o, 0, quote));
      if (owner === '$elemMatch') {
        const base = fieldPathOf(ctx.keys);
        return [...fieldSuggestions(fields, base, quote, 0), ...QUERY_OPERATORS.map((o) => opSuggestion(o, 5, quote))];
      }
      if (owner.startsWith('$')) return QUERY_OPERATORS.map((o) => opSuggestion(o, 0, quote));
      // inside { field: { | } }: operators first, then sub-fields
      return [...QUERY_OPERATORS.map((o) => opSuggestion(o, 0, quote)), ...fieldSuggestions(fields, fieldPathOf(ctx.keys), quote, 10)];
    }
    if (ctx.where === 'value') {
      if (owner === '$exists') return ['true', 'false'].map((b) => ({ label: b, insert: b, kind: 'keyword' as const, rank: 0 }));
      if (owner === '$type') {
        return TYPE_ALIASES.map((a) => ({ label: quote ? a : `"${a}"`, insert: quote ? a : `"${a}"`, kind: 'value' as const, rank: 0 }));
      }
      if (owner === '$expr' || ctx.keys.includes('$expr')) return refSuggestions(fields, quote, 0);
      if (owner !== null && (COMPARE.has(owner) || !owner.startsWith('$'))) {
        const vs = valueSuggestions(byPath.get(fieldPathOf(ctx.keys)), quote);
        if (owner !== null && !owner.startsWith('$') && !quote) {
          vs.push({ label: '{ $… }', insert: '{ ${1} }', snippet: true, kind: 'operator', detail: 'operator expression', rank: 4 });
        }
        return vs;
      }
    }
    return [];
  }

  if (mode === 'projection' || stage === '$project') {
    if (ctx.where === 'key') return owner === null ? fieldSuggestions(fields, '', quote, 0) : EXPRESSIONS.map((o) => opSuggestion(o, 0, quote));
    if (ctx.where === 'value' && !quote) {
      const vals = ['1', '0'].map((v, i) => ({ label: v, insert: v, kind: 'value' as const, detail: i ? 'exclude' : 'include', rank: i }));
      return [...vals, ...refSuggestions(fields, null, 5)];
    }
    return [];
  }

  if (mode === 'sort' || stage === '$sort') {
    if (ctx.where === 'key') return fieldSuggestions(fields, '', quote, 0);
    if (ctx.where === 'value' && !quote) {
      return [{ label: '1', insert: '1', kind: 'value', detail: 'ascending', rank: 0 }, { label: '-1', insert: '-1', kind: 'value', detail: 'descending', rank: 1 }];
    }
    return [];
  }

  if (mode === 'collation') {
    if (ctx.where === 'key') {
      return ['locale', 'strength', 'caseLevel', 'caseFirst', 'numericOrdering', 'alternate', 'backwards'].map((k, i) => ({ label: k, insert: k, kind: 'keyword' as const, rank: i }));
    }
    return [];
  }

  if (stage === '$lookup' || stage === '$graphLookup' || stage === '$unionWith') {
    if (ctx.where === 'key' && ctx.keys.length === 0) {
      const ks = stage === '$lookup' ? ['from', 'localField', 'foreignField', 'as', 'let', 'pipeline'] : stage === '$unionWith' ? ['coll', 'pipeline'] : ['from', 'startWith', 'connectFromField', 'connectToField', 'as', 'maxDepth', 'depthField', 'restrictSearchWithMatch'];
      return ks.map((k, i) => ({ label: k, insert: k, kind: 'keyword', rank: i }));
    }
    if (ctx.where === 'value' && (owner === 'localField' || owner === 'connectFromField')) {
      return fields.map((f) => ({ label: f.path, insert: quote ? f.path : JSON.stringify(f.path), kind: 'field' as const, rank: 0 }));
    }
    return [];
  }

  if (stage === '$group' || stage === '$bucket' || stage === '$bucketAuto' || stage === '$setWindowFields') {
    if (ctx.where === 'key') {
      if (ctx.keys.length === 0) return [{ label: '_id', insert: '_id', kind: 'keyword', detail: 'group key', rank: 0 }];
      return [...ACCUMULATORS.map((o) => opSuggestion(o, 0, quote)), ...EXPRESSIONS.map((o) => opSuggestion(o, 5, quote))];
    }
    if (ctx.where === 'value') return [...refSuggestions(fields, quote, 0), ...(quote ? [] : [{ label: 'null', insert: 'null', kind: 'keyword' as const, rank: 3 }])];
    return [];
  }

  if (stage) {
    // $addFields, $set, $replaceRoot, $unwind, $sortByCount, $count, $facet …
    if (ctx.where === 'key') {
      if (ctx.keys.length === 0 && (stage === '$addFields' || stage === '$set')) return fieldSuggestions(fields, '', quote, 0);
      if (ctx.keys.length === 0 && stage === '$unwind') return ['path', 'includeArrayIndex', 'preserveNullAndEmptyArrays'].map((k, i) => ({ label: k, insert: k, kind: 'keyword', rank: i }));
      if (ctx.keys.length === 0 && stage === '$facet') return [];
      if (ctx.keys.length === 0 && stage === '$replaceRoot') return [{ label: 'newRoot', insert: 'newRoot', kind: 'keyword', rank: 0 }];
      return EXPRESSIONS.map((o) => opSuggestion(o, 0, quote));
    }
    if (ctx.where === 'value') return refSuggestions(fields, quote, 0);
    return [];
  }

  // document editor: field names only
  if (ctx.where === 'key' && ctx.keys.length === 0) return fieldSuggestions(fields, '', quote, 0).filter((s) => !s.label.includes('.'));
  return [];
}

/** Stage names for the stage picker (write stages flagged). */
export function stageNames(): { name: string; summary: string; write: boolean }[] {
  return STAGES.map((s) => ({ name: s.name, summary: s.summary, write: !!s.write }));
}
