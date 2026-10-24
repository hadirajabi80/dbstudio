// Query DSL completion (plan-batch3 WP-ES): a lenient scanner finds where the cursor is in a JSON body (key or value
// position, the path of keys above it), a small grammar maps that path to a context, and the context lists the keys,
// field names and enum values to offer. Pure (the Monaco provider in components/Elasticsearch/language.ts adapts it).
import type { EsField } from '../api/types.es';

export type ValueKind = 'obj' | 'arr' | 'str' | 'num' | 'bool' | 'any';

export interface JsonCursor {
  /** Keys from the root to the container of the cursor; array items are `[]`. */
  path: string[];
  /** True where an object key is expected. */
  inKey: boolean;
  /** For a value position: the key whose value is being typed (null inside arrays of the root). */
  key: string | null;
  /** The cursor is inside a string literal (prefix = text typed after the quote). */
  inString: boolean;
  prefix: string;
  /** Container of the cursor. */
  container: 'obj' | 'arr' | 'none';
  /** Keys already present before the cursor in the current object. */
  siblings: string[];
}

interface Frame { type: 'obj' | 'arr'; key: string | null; expectKey: boolean; pendingKey: string | null; valueKey: string | null; siblings: string[] }

/** Scans `text` (the body up to the cursor). */
export function analyzeJson(text: string): JsonCursor {
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  let inString = false;
  let prefix = '';
  let lastWord = '';
  const top = () => stack[stack.length - 1];
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < n) {
        if (text[j] === '\\') {
          s += text[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          closed = true;
          break;
        }
        s += text[j];
        j++;
      }
      if (!closed) {
        inString = true;
        prefix = s;
        break;
      }
      const f = top();
      if (f?.type === 'obj' && f.expectKey) {
        f.pendingKey = s;
        f.expectKey = false;
      }
      i = j + 1;
      lastWord = '';
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '{' || ch === '[') {
      const parent = top();
      const key = parent ? (parent.type === 'arr' ? '[]' : parent.valueKey) : null;
      stack.push({ type: ch === '{' ? 'obj' : 'arr', key, expectKey: ch === '{', pendingKey: null, valueKey: null, siblings: [] });
      i++;
      lastWord = '';
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      const f = top();
      if (f?.type === 'obj') f.valueKey = null;
      i++;
      lastWord = '';
      continue;
    }
    if (ch === ':') {
      const f = top();
      if (f?.type === 'obj') {
        f.valueKey = f.pendingKey;
        if (f.pendingKey) f.siblings.push(f.pendingKey);
        f.pendingKey = null;
      }
      i++;
      lastWord = '';
      continue;
    }
    if (ch === ',') {
      const f = top();
      if (f?.type === 'obj') {
        f.expectKey = true;
        f.valueKey = null;
        f.pendingKey = null;
      }
      i++;
      lastWord = '';
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      lastWord = '';
      continue;
    }
    lastWord += ch;
    i++;
  }
  const f = top();
  const path = stack.slice(1).map((s) => s.key ?? '');
  if (!f) return { path: [], inKey: false, key: null, inString, prefix: inString ? prefix : lastWord, container: 'none', siblings: [] };
  const inKey = f.type === 'obj' && (f.expectKey || (f.pendingKey === null && f.valueKey === null));
  return {
    path,
    inKey,
    key: f.type === 'obj' ? (inKey ? null : f.valueKey) : null,
    inString,
    prefix: inString ? prefix : lastWord,
    container: f.type,
    siblings: f.siblings,
  };
}

// ---- grammar

export type DslContext =
  | { kind: 'root' }
  | { kind: 'query' }
  | { kind: 'fieldMap'; clause: string }
  | { kind: 'fieldBody'; clause: string }
  | { kind: 'clause'; clause: string }
  | { kind: 'queryList' }
  | { kind: 'aggs' }
  | { kind: 'aggBody' }
  | { kind: 'aggType'; agg: string }
  | { kind: 'sort' }
  | { kind: 'sortField' }
  | { kind: 'highlight' }
  | { kind: 'highlightFields' }
  | { kind: 'source' }
  | { kind: 'fieldList' }
  | { kind: 'filtersMap' }
  | { kind: 'unknown' };

/** Query clauses whose keys are field names (`{ "match": { "<field>": … } }`). */
export const FIELD_CLAUSES = new Set(['match', 'match_phrase', 'match_phrase_prefix', 'match_bool_prefix', 'term', 'terms', 'range', 'prefix', 'wildcard', 'regexp', 'fuzzy', 'geo_distance', 'geo_bounding_box', 'intervals', 'span_term']);

const K = (name: string, kind: ValueKind, doc: string) => ({ name, kind, doc });
export type KeyDef = ReturnType<typeof K>;

export const ROOT_KEYS: KeyDef[] = [
  K('query', 'obj', 'The query (scored).'), K('aggs', 'obj', 'Aggregations.'), K('size', 'num', 'Number of hits (default 10).'),
  K('from', 'num', 'Offset of the first hit.'), K('sort', 'arr', 'Sort order.'), K('_source', 'any', 'Source filtering (false, field list, includes/excludes).'),
  K('highlight', 'obj', 'Highlight matches.'), K('track_total_hits', 'bool', 'Exact total (true) or a lower bound.'), K('post_filter', 'obj', 'Filter applied after aggregations.'),
  K('explain', 'bool', 'Explain the score of each hit.'), K('search_after', 'arr', 'Sort values of the last hit (keyset paging).'), K('timeout', 'str', 'Search timeout ("2s").'),
  K('min_score', 'num', 'Minimum score.'), K('fields', 'arr', 'Fields to return from the mapping.'), K('collapse', 'obj', 'Collapse hits on a field.'),
  K('script_fields', 'obj', 'Computed fields.'), K('runtime_mappings', 'obj', 'Runtime fields of this request.'), K('suggest', 'obj', 'Suggesters.'),
  K('profile', 'bool', 'Profile the query execution.'), K('version', 'bool', 'Return the document version.'), K('seq_no_primary_term', 'bool', 'Return _seq_no and _primary_term.'),
  K('stored_fields', 'arr', 'Stored fields to return.'), K('docvalue_fields', 'arr', 'Doc value fields to return.'), K('rescore', 'obj', 'Rescore the top hits.'),
  K('terminate_after', 'num', 'Stop after this many docs per shard.'), K('indices_boost', 'arr', 'Boost per index.'), K('knn', 'obj', 'Approximate kNN search.'),
];

export const QUERY_KEYS: KeyDef[] = [
  K('match_all', 'obj', 'Matches every document.'), K('match', 'obj', 'Full-text match on a field.'), K('match_phrase', 'obj', 'Phrase match.'),
  K('match_phrase_prefix', 'obj', 'Phrase with a prefix on the last term.'), K('multi_match', 'obj', 'Match on several fields.'), K('bool', 'obj', 'Combine queries (must, filter, should, must_not).'),
  K('term', 'obj', 'Exact value (keyword, numbers, dates).'), K('terms', 'obj', 'Any of several exact values.'), K('range', 'obj', 'Range (gte, gt, lte, lt).'),
  K('exists', 'obj', 'The field has a value.'), K('prefix', 'obj', 'Prefix of a keyword.'), K('wildcard', 'obj', 'Wildcard pattern (* ?).'),
  K('regexp', 'obj', 'Regular expression.'), K('fuzzy', 'obj', 'Fuzzy term.'), K('ids', 'obj', 'Documents by _id.'), K('query_string', 'obj', 'Lucene query syntax.'),
  K('simple_query_string', 'obj', 'Simple query syntax (never fails).'), K('nested', 'obj', 'Query nested objects.'), K('constant_score', 'obj', 'Filter with a constant score.'),
  K('function_score', 'obj', 'Modify scores with functions.'), K('dis_max', 'obj', 'Best of several queries.'), K('boosting', 'obj', 'Demote matches of a negative query.'),
  K('match_none', 'obj', 'Matches nothing.'), K('combined_fields', 'obj', 'Match over fields as one combined field.'), K('more_like_this', 'obj', 'Similar documents.'),
  K('script', 'obj', 'Script filter.'), K('geo_distance', 'obj', 'Within a distance of a point.'), K('geo_bounding_box', 'obj', 'Within a bounding box.'),
  K('has_child', 'obj', 'Parents with matching children.'), K('has_parent', 'obj', 'Children with matching parents.'), K('intervals', 'obj', 'Proximity of terms.'),
];

const CLAUSE_PARAMS: Record<string, KeyDef[]> = {
  bool: [K('must', 'arr', 'Must match (scored).'), K('filter', 'arr', 'Must match (not scored, cached).'), K('should', 'arr', 'Should match.'),
    K('must_not', 'arr', 'Must not match.'), K('minimum_should_match', 'any', 'How many should clauses must match.'), K('boost', 'num', 'Boost.')],
  multi_match: [K('query', 'str', 'Text to search.'), K('fields', 'arr', 'Fields (boost with ^2).'), K('type', 'str', 'best_fields, most_fields, cross_fields, phrase…'),
    K('operator', 'str', 'or | and.'), K('fuzziness', 'any', 'AUTO or an edit distance.'), K('tie_breaker', 'num', 'Weight of the other fields.'), K('minimum_should_match', 'any', '')],
  query_string: [K('query', 'str', 'Lucene syntax: status:paid AND total:>100'), K('default_field', 'str', 'Field for terms without one.'), K('fields', 'arr', 'Fields.'),
    K('default_operator', 'str', 'OR | AND.'), K('analyze_wildcard', 'bool', ''), K('lenient', 'bool', 'Ignore format errors.')],
  simple_query_string: [K('query', 'str', 'Simple syntax: +paid -cancelled'), K('fields', 'arr', 'Fields.'), K('default_operator', 'str', 'OR | AND.')],
  exists: [K('field', 'str', 'Field name.')],
  ids: [K('values', 'arr', 'Document ids.')],
  nested: [K('path', 'str', 'The nested field.'), K('query', 'obj', 'Query on the nested objects.'), K('score_mode', 'str', 'avg | max | min | sum | none'),
    K('inner_hits', 'obj', 'Return the matching nested objects.'), K('ignore_unmapped', 'bool', '')],
  constant_score: [K('filter', 'obj', 'The filter.'), K('boost', 'num', 'Score.')],
  function_score: [K('query', 'obj', 'Base query.'), K('functions', 'arr', 'Score functions.'), K('score_mode', 'str', ''), K('boost_mode', 'str', ''),
    K('field_value_factor', 'obj', ''), K('random_score', 'obj', ''), K('min_score', 'num', '')],
  dis_max: [K('queries', 'arr', 'Queries.'), K('tie_breaker', 'num', '')],
  boosting: [K('positive', 'obj', 'Query to match.'), K('negative', 'obj', 'Query to demote.'), K('negative_boost', 'num', '')],
  has_child: [K('type', 'str', 'Child relation.'), K('query', 'obj', ''), K('score_mode', 'str', '')],
  has_parent: [K('parent_type', 'str', 'Parent relation.'), K('query', 'obj', ''), K('score', 'bool', '')],
  match_all: [K('boost', 'num', '')],
  script: [K('script', 'obj', '{ "source": "…", "params": {} }')],
  more_like_this: [K('fields', 'arr', ''), K('like', 'any', ''), K('min_term_freq', 'num', ''), K('max_query_terms', 'num', '')],
  combined_fields: [K('query', 'str', ''), K('fields', 'arr', ''), K('operator', 'str', '')],
  collapse: [K('field', 'str', 'Keyword or numeric field.'), K('inner_hits', 'obj', '')],
};

const FIELD_BODY: Record<string, KeyDef[]> = {
  match: [K('query', 'any', 'Text to search.'), K('operator', 'str', 'or | and.'), K('fuzziness', 'any', 'AUTO or an edit distance.'),
    K('minimum_should_match', 'any', ''), K('analyzer', 'str', ''), K('zero_terms_query', 'str', 'none | all'), K('lenient', 'bool', ''), K('boost', 'num', '')],
  match_phrase: [K('query', 'str', ''), K('slop', 'num', 'Allowed distance between terms.'), K('analyzer', 'str', '')],
  match_phrase_prefix: [K('query', 'str', ''), K('max_expansions', 'num', ''), K('slop', 'num', '')],
  term: [K('value', 'any', 'Exact value.'), K('boost', 'num', ''), K('case_insensitive', 'bool', '')],
  range: [K('gte', 'any', '≥'), K('gt', 'any', '>'), K('lte', 'any', '≤'), K('lt', 'any', '<'), K('format', 'str', 'Date format.'),
    K('time_zone', 'str', '+01:00 or Europe/Berlin'), K('relation', 'str', 'INTERSECTS | CONTAINS | WITHIN'), K('boost', 'num', '')],
  prefix: [K('value', 'str', ''), K('case_insensitive', 'bool', '')],
  wildcard: [K('value', 'str', 'Pattern with * and ?'), K('case_insensitive', 'bool', '')],
  regexp: [K('value', 'str', ''), K('flags', 'str', ''), K('case_insensitive', 'bool', '')],
  fuzzy: [K('value', 'str', ''), K('fuzziness', 'any', ''), K('prefix_length', 'num', '')],
};

export const AGG_TYPES: KeyDef[] = [
  K('terms', 'obj', 'Buckets per value.'), K('date_histogram', 'obj', 'Buckets per time interval.'), K('histogram', 'obj', 'Buckets per numeric interval.'),
  K('range', 'obj', 'Buckets per range.'), K('date_range', 'obj', 'Buckets per date range.'), K('avg', 'obj', 'Average.'), K('sum', 'obj', 'Sum.'),
  K('min', 'obj', 'Minimum.'), K('max', 'obj', 'Maximum.'), K('stats', 'obj', 'count, min, max, avg, sum.'), K('extended_stats', 'obj', 'stats + variance…'),
  K('cardinality', 'obj', 'Approximate distinct count.'), K('value_count', 'obj', 'Number of values.'), K('percentiles', 'obj', 'Percentiles.'),
  K('filter', 'obj', 'One bucket of matching docs.'), K('filters', 'obj', 'Named filter buckets.'), K('nested', 'obj', 'Aggregate nested objects.'),
  K('reverse_nested', 'obj', 'Back to the parent documents.'), K('top_hits', 'obj', 'Top documents per bucket.'), K('significant_terms', 'obj', 'Unusual terms.'),
  K('composite', 'obj', 'Paginated multi-source buckets.'), K('missing', 'obj', 'Docs without the field.'), K('auto_date_histogram', 'obj', ''),
  K('aggs', 'obj', 'Sub-aggregations.'),
];

const AGG_PARAMS: Record<string, KeyDef[]> = {
  terms: [K('field', 'str', 'Keyword/numeric field.'), K('size', 'num', 'Buckets (default 10).'), K('order', 'obj', '{ "_count": "desc" }'),
    K('min_doc_count', 'num', ''), K('missing', 'any', ''), K('include', 'any', ''), K('exclude', 'any', ''), K('shard_size', 'num', '')],
  date_histogram: [K('field', 'str', 'Date field.'), K('calendar_interval', 'str', 'minute, hour, day, week, month, quarter, year'),
    K('fixed_interval', 'str', '30m, 12h, 7d'), K('format', 'str', 'yyyy-MM-dd'), K('time_zone', 'str', ''), K('min_doc_count', 'num', ''), K('extended_bounds', 'obj', '')],
  histogram: [K('field', 'str', ''), K('interval', 'num', ''), K('min_doc_count', 'num', ''), K('extended_bounds', 'obj', '')],
  range: [K('field', 'str', ''), K('ranges', 'arr', '[{ "to": 50 }, { "from": 50 }]'), K('keyed', 'bool', '')],
  date_range: [K('field', 'str', ''), K('ranges', 'arr', ''), K('format', 'str', '')],
  nested: [K('path', 'str', 'Nested field.')],
  reverse_nested: [K('path', 'str', '')],
  top_hits: [K('size', 'num', ''), K('sort', 'arr', ''), K('_source', 'any', '')],
  percentiles: [K('field', 'str', ''), K('percents', 'arr', '[50, 95, 99]')],
  composite: [K('sources', 'arr', ''), K('size', 'num', ''), K('after', 'obj', '')],
  filters: [K('filters', 'obj', 'Named queries.'), K('other_bucket', 'bool', '')],
  significant_terms: [K('field', 'str', ''), K('size', 'num', '')],
};
for (const m of ['avg', 'sum', 'min', 'max', 'stats', 'extended_stats', 'cardinality', 'value_count', 'missing']) {
  AGG_PARAMS[m] = [K('field', 'str', 'Field.'), K('missing', 'any', 'Value for docs without the field.'), K('script', 'obj', '')];
}

const SORT_FIELD_KEYS: KeyDef[] = [K('order', 'str', 'asc | desc'), K('mode', 'str', 'min | max | sum | avg | median'), K('missing', 'any', '_last | _first'),
  K('unmapped_type', 'str', ''), K('nested', 'obj', ''), K('format', 'str', '')];
const HIGHLIGHT_KEYS: KeyDef[] = [K('fields', 'obj', 'Fields to highlight.'), K('pre_tags', 'arr', ''), K('post_tags', 'arr', ''), K('fragment_size', 'num', ''),
  K('number_of_fragments', 'num', ''), K('type', 'str', 'unified | plain | fvh'), K('require_field_match', 'bool', '')];
const SOURCE_KEYS: KeyDef[] = [K('includes', 'arr', 'Fields to keep (wildcards).'), K('excludes', 'arr', 'Fields to drop.')];

export const ENUMS: Record<string, string[]> = {
  operator: ['or', 'and'], order: ['asc', 'desc'], default_operator: ['OR', 'AND'], zero_terms_query: ['none', 'all'],
  calendar_interval: ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'], score_mode: ['avg', 'max', 'min', 'sum', 'none', 'multiply', 'first'],
  boost_mode: ['multiply', 'replace', 'sum', 'avg', 'max', 'min'], type: ['best_fields', 'most_fields', 'cross_fields', 'phrase', 'phrase_prefix', 'bool_prefix'],
  relation: ['INTERSECTS', 'CONTAINS', 'WITHIN'], fuzziness: ['AUTO'], mode: ['min', 'max', 'sum', 'avg', 'median'], missing: ['_last', '_first'],
};

const QUERY_SUBKEYS: Record<string, Record<string, 'query' | 'queryList'>> = {
  bool: { must: 'queryList', filter: 'queryList', should: 'queryList', must_not: 'queryList' },
  nested: { query: 'query' }, constant_score: { filter: 'query' }, function_score: { query: 'query' }, dis_max: { queries: 'queryList' },
  boosting: { positive: 'query', negative: 'query' }, has_child: { query: 'query' }, has_parent: { query: 'query' },
};

function step(ctx: DslContext, key: string): DslContext {
  switch (ctx.kind) {
    case 'root':
      if (key === 'query' || key === 'post_filter') return { kind: 'query' };
      if (key === 'aggs' || key === 'aggregations') return { kind: 'aggs' };
      if (key === 'sort') return { kind: 'sort' };
      if (key === 'highlight') return { kind: 'highlight' };
      if (key === '_source') return { kind: 'source' };
      if (key === 'fields' || key === 'docvalue_fields' || key === 'stored_fields') return { kind: 'fieldList' };
      if (key === 'collapse') return { kind: 'clause', clause: 'collapse' };
      return { kind: 'unknown' };
    case 'query':
      if (FIELD_CLAUSES.has(key)) return { kind: 'fieldMap', clause: key };
      return { kind: 'clause', clause: key };
    case 'queryList':
      return key === '[]' ? { kind: 'query' } : step({ kind: 'query' }, key);
    case 'fieldMap':
      return { kind: 'fieldBody', clause: ctx.clause };
    case 'clause': {
      const sub = QUERY_SUBKEYS[ctx.clause]?.[key];
      if (sub) return { kind: sub };
      if ((ctx.clause === 'multi_match' || ctx.clause === 'query_string' || ctx.clause === 'simple_query_string' || ctx.clause === 'combined_fields') && key === 'fields') {
        return { kind: 'fieldList' };
      }
      if (ctx.clause === 'filters' && key === 'filters') return { kind: 'filtersMap' };
      return { kind: 'unknown' };
    }
    case 'aggs':
      return { kind: 'aggBody' };
    case 'aggBody':
      if (key === 'aggs' || key === 'aggregations') return { kind: 'aggs' };
      if (key === 'filter') return { kind: 'query' };
      return { kind: 'aggType', agg: key };
    case 'aggType':
      if (ctx.agg === 'filters' && key === 'filters') return { kind: 'filtersMap' };
      if (ctx.agg === 'top_hits' && key === 'sort') return { kind: 'sort' };
      if (ctx.agg === 'top_hits' && key === '_source') return { kind: 'source' };
      return { kind: 'unknown' };
    case 'filtersMap':
      return { kind: 'query' };
    case 'sort':
      return key === '[]' ? { kind: 'sort' } : { kind: 'sortField' };
    case 'highlight':
      return key === 'fields' ? { kind: 'highlightFields' } : { kind: 'unknown' };
    case 'highlightFields':
      return { kind: 'unknown' };
    case 'source':
      return key === 'includes' || key === 'excludes' ? { kind: 'fieldList' } : { kind: 'unknown' };
    default:
      return { kind: 'unknown' };
  }
}

/** Context of the container at `path` (from the body root). */
export function contextOf(path: readonly string[], start: DslContext = { kind: 'root' }): DslContext {
  let ctx = start;
  for (const k of path) ctx = step(ctx, k);
  return ctx;
}

export interface DslSuggestion {
  label: string;
  /** 'key' inserts `"label": <value>`; 'field' / 'value' insert the text (quoted unless inString). */
  type: 'key' | 'field' | 'value';
  kind?: ValueKind;
  detail?: string;
  doc?: string;
}

const fieldSugs = (fields: readonly EsField[], filter?: (f: EsField) => boolean): DslSuggestion[] =>
  fields.filter((f) => f.type !== 'object' && (!filter || filter(f))).map((f) => ({ label: f.path, type: 'field', detail: f.type }));

const keySugs = (defs: readonly KeyDef[], siblings: readonly string[]): DslSuggestion[] =>
  defs.filter((d) => !siblings.includes(d.name)).map((d) => ({ label: d.name, type: 'key', kind: d.kind, doc: d.doc || undefined }));

/** Suggestions at the cursor of a search body (`text` = body text up to the cursor). */
export function suggest(text: string, fields: readonly EsField[], start: DslContext = { kind: 'root' }): { cursor: JsonCursor; items: DslSuggestion[] } {
  const cursor = analyzeJson(text);
  if (cursor.container === 'none') return { cursor, items: [] };
  const ctx = contextOf(cursor.path, start);
  const items: DslSuggestion[] = [];
  if (cursor.inKey) {
    switch (ctx.kind) {
      case 'root': items.push(...keySugs(ROOT_KEYS, cursor.siblings)); break;
      case 'query': items.push(...keySugs(QUERY_KEYS, cursor.siblings)); break;
      case 'clause': items.push(...keySugs(CLAUSE_PARAMS[ctx.clause] ?? [], cursor.siblings)); break;
      case 'fieldMap': items.push(...fieldSugs(fields, (f) => ctx.clause !== 'range' || /date|long|integer|short|byte|double|float|half_float|scaled_float|ip|keyword|unsigned_long/.test(f.type)).map((s) => ({ ...s, type: 'key' as const, kind: 'obj' as ValueKind }))); break;
      case 'fieldBody': items.push(...keySugs(FIELD_BODY[ctx.clause] ?? FIELD_BODY.term, cursor.siblings)); break;
      case 'aggBody': items.push(...keySugs(AGG_TYPES, cursor.siblings)); break;
      case 'aggType': items.push(...keySugs(AGG_PARAMS[ctx.agg] ?? [], cursor.siblings)); break;
      case 'sort': items.push(...fieldSugs(fields, (f) => f.aggregatable).map((s) => ({ ...s, type: 'key' as const, kind: 'obj' as ValueKind })), { label: '_score', type: 'key', kind: 'obj' }); break;
      case 'sortField': items.push(...keySugs(SORT_FIELD_KEYS, cursor.siblings)); break;
      case 'highlight': items.push(...keySugs(HIGHLIGHT_KEYS, cursor.siblings)); break;
      case 'highlightFields': items.push(...fieldSugs(fields, (f) => f.type === 'text' || f.type === 'keyword').map((s) => ({ ...s, type: 'key' as const, kind: 'obj' as ValueKind }))); break;
      case 'source': items.push(...keySugs(SOURCE_KEYS, cursor.siblings)); break;
      default: break;
    }
    return { cursor, items };
  }
  // value position (or an array item)
  const key = cursor.key;
  if (cursor.container === 'arr') {
    if (ctx.kind === 'fieldList' || ctx.kind === 'sort' || ctx.kind === 'source') items.push(...fieldSugs(fields));
    if (ctx.kind === 'sort') items.push({ label: '_score', type: 'value' }, { label: '_doc', type: 'value' });
    return { cursor, items };
  }
  if (key === 'field' || key === 'default_field') {
    const aggregatableOnly = ctx.kind === 'aggType' && ctx.agg !== 'missing' && ctx.agg !== 'value_count';
    items.push(...fieldSugs(fields, aggregatableOnly ? (f) => f.aggregatable : undefined));
  } else if (key === 'path') {
    items.push(...fieldSugs(fields.filter((f) => f.type === 'nested').map((f) => ({ ...f, type: 'nested-path' }))));
  } else if (key && ENUMS[key]) {
    items.push(...ENUMS[key].map((v) => ({ label: v, type: 'value' as const })));
  } else if (key && ctx.kind === 'root' && (key === 'track_total_hits' || key === 'explain' || key === 'profile' || key === 'version')) {
    items.push({ label: 'true', type: 'value' }, { label: 'false', type: 'value' });
  }
  return { cursor, items };
}

/** Snippet text inserted after a key (`"key": <this>`), Monaco snippet syntax. */
export function valueSnippet(kind: ValueKind | undefined): string {
  switch (kind) {
    case 'obj': return '{\n\t$0\n}';
    case 'arr': return '[\n\t$0\n]';
    case 'str': return '"$0"';
    case 'num': return '${0:10}';
    case 'bool': return '${0:true}';
    default: return '$0';
  }
}
