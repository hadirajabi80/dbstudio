// Identifier conventions for generated code: word splitting, case styles, singularisation and
// reserved-word escaping per target language. Pure TypeScript.

export type NamingStyle = 'pascal' | 'camel' | 'snake' | 'asIs';
export type TargetLang = 'csharp' | 'go' | 'typescript' | 'java' | 'python';

/** Split an identifier into words: `ORDER_LINES`, `orderLines`, `OrderLines`, `HTMLParser2`, `iso-code`. */
export function splitWords(name: string): string[] {
  const parts = name
    .replace(/^[@:$?]+/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const words: string[] = [];
  for (const p of parts) {
    // ALLCAPS (incl. digits) is one word; otherwise split on case boundaries.
    if (/^[A-Z0-9]+$/.test(p)) {
      words.push(p);
      continue;
    }
    const re = /[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g;
    let m: RegExpExecArray | null;
    let last = 0;
    const local: string[] = [];
    while ((m = re.exec(p))) {
      if (m.index > last) local.push(p.slice(last, m.index));
      local.push(m[0]);
      last = m.index + m[0].length;
    }
    if (last < p.length) local.push(p.slice(last));
    // Attach pure digit groups to the previous word (`Address2`, `line2`).
    local.forEach((w, i) => {
      if (i > 0 && /^[0-9]+$/.test(w)) words[words.length - 1] += w;
      else words.push(w);
    });
  }
  return words.length ? words : [name.replace(/[^A-Za-z0-9_]/g, '_') || 'x'];
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

export function pascal(name: string): string {
  return safeStart(splitWords(name).map(cap).join(''));
}

export function camel(name: string): string {
  const p = pascal(name);
  // Keep a leading underscore guard from safeStart.
  if (p.startsWith('_')) return p;
  return p.charAt(0).toLowerCase() + p.slice(1);
}

export function snake(name: string): string {
  return safeStart(splitWords(name).map((w) => w.toLowerCase()).join('_'));
}

/** Go initialisms (golint list, trimmed to what shows up in schemas). */
const GO_INITIALISMS = new Set([
  'ID', 'URL', 'URI', 'HTTP', 'HTTPS', 'API', 'JSON', 'XML', 'SQL', 'UUID', 'GUID', 'IP', 'UTC', 'CPU', 'DNS', 'EOF', 'HTML', 'TCP', 'UDP', 'UI', 'TTL', 'SKU', 'VAT', 'ISO',
]);

/** Exported Go identifier with initialisms upper-cased: `customer_id` → `CustomerID`. */
export function goPascal(name: string): string {
  return safeStart(
    splitWords(name)
      .map((w) => (GO_INITIALISMS.has(w.toUpperCase()) ? w.toUpperCase() : cap(w)))
      .join(''),
  );
}

/** Unexported Go identifier: `CustomerID` → `customerID`, `ID` → `id`. */
export function goCamel(name: string): string {
  const words = splitWords(name);
  return safeStart(
    words
      .map((w, i) => {
        const up = w.toUpperCase();
        if (i === 0) return w.toLowerCase();
        return GO_INITIALISMS.has(up) ? up : cap(w);
      })
      .join(''),
  );
}

function safeStart(s: string): string {
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

/** Valid identifier from any text, keeping the original spelling as much as possible (`asIs` style). */
export function asIs(name: string): string {
  const s = name.replace(/^[@:$?]+/, '').replace(/[^A-Za-z0-9_]/g, '_');
  return safeStart(s || 'x');
}

export function applyStyle(name: string, style: NamingStyle): string {
  switch (style) {
    case 'pascal':
      return pascal(name);
    case 'camel':
      return camel(name);
    case 'snake':
      return snake(name);
    default:
      return asIs(name);
  }
}

// ---------------- singularisation ----------------

const IRREGULAR: Record<string, string> = {
  people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose', teeth: 'tooth', feet: 'foot',
  indices: 'index', matrices: 'matrix', vertices: 'vertex', criteria: 'criterion', phenomena: 'phenomenon', analyses: 'analysis',
  statuses: 'status', buses: 'bus', campuses: 'campus', viruses: 'virus', aliases: 'alias', movies: 'movie', cookies: 'cookie',
  quizzes: 'quiz', leaves: 'leaf', lives: 'life', wives: 'wife', knives: 'knife', halves: 'half', shelves: 'shelf', houses: 'house',
  courses: 'course', responses: 'response', licenses: 'license', purchases: 'purchase', expenses: 'expense', cases: 'case',
  bases: 'base', databases: 'database', releases: 'release', invoices: 'invoice', prices: 'price', devices: 'device', services: 'service',
  sources: 'source', resources: 'resource', choices: 'choice', notices: 'notice', addresses: 'address', warehouses: 'warehouse',
};
/** Words that are already singular (or uncountable). */
const UNCOUNTABLE = new Set([
  'data', 'news', 'series', 'species', 'status', 'info', 'information', 'equipment', 'metadata', 'media', 'staff', 'sheep', 'fish',
  'access', 'process', 'address', 'class', 'business', 'analysis', 'basis', 'axis', 'campus', 'bus', 'alias', 'canvas', 'gas',
  'settings', 'stats', 'analytics', 'progress', 'feedback', 'audit', 'history', 'inventory', 'stock',
]);

export interface SingularOptions {
  /** `Status, Data=Datum`: a bare word is never changed, `plural=singular` maps explicitly. Comma, semicolon or newline separated. */
  exceptions?: string;
}

function parseExceptions(text: string | undefined): { keep: Set<string>; map: Map<string, string> } {
  const keep = new Set<string>();
  const map = new Map<string, string>();
  for (const raw of (text ?? '').split(/[,;\n]+/)) {
    const e = raw.trim();
    if (!e) continue;
    const eq = e.indexOf('=');
    if (eq > 0) map.set(e.slice(0, eq).trim().toLowerCase(), e.slice(eq + 1).trim());
    else keep.add(e.toLowerCase());
  }
  return { keep, map };
}

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** Singular form of one English word, preserving its case style. */
export function singularWord(word: string, opts: SingularOptions = {}): string {
  const lower = word.toLowerCase();
  const ex = parseExceptions(opts.exceptions);
  if (ex.keep.has(lower)) return word;
  const mapped = ex.map.get(lower);
  if (mapped) return matchCase(word, mapped);
  if (UNCOUNTABLE.has(lower)) return word;
  const irr = IRREGULAR[lower];
  if (irr) return matchCase(word, irr);
  if (lower.length <= 2) return word;
  let s: string | null = null;
  if (/[^aeiou]ies$/.test(lower)) s = lower.slice(0, -3) + 'y';
  else if (/(ss|x|ch|sh|zz)es$/.test(lower)) s = lower.slice(0, -2);
  else if (/(ss|us|is|os)$/.test(lower)) s = lower;
  else if (/s$/.test(lower)) s = lower.slice(0, -1);
  if (s === null || s === lower) return word;
  // Keep the original characters of the common prefix, append the new tail in the word's case.
  let common = 0;
  while (common < s.length && s[common] === lower[common]) common++;
  const tail = s.slice(common);
  return word.slice(0, common) + (word === word.toUpperCase() ? tail.toUpperCase() : tail);
}

/** Singularise the last word of a (multi-word) identifier: `ORDER_LINES` → `ORDER_LINE`, `vActiveCustomers` → `vActiveCustomer`. */
export function singularize(name: string, opts: SingularOptions = {}): string {
  // Exceptions apply to the whole name first.
  const ex = parseExceptions(opts.exceptions);
  if (ex.keep.has(name.toLowerCase())) return name;
  const whole = ex.map.get(name.toLowerCase());
  if (whole) return whole;
  const m = /^(.*?)([A-Za-z]+)([^A-Za-z]*)$/.exec(name);
  if (!m) return name;
  const [, head, tail, rest] = m;
  // Split the trailing word on camel boundaries: `ActiveCustomers` → `Customers`.
  const cm = /^(.*?)([A-Z]?[a-z]+|[A-Z]+)$/.exec(tail);
  const prefix = cm ? cm[1] : '';
  const last = cm ? cm[2] : tail;
  return head + prefix + singularWord(last, opts) + rest;
}

// ---------------- reserved words ----------------

const RESERVED: Record<TargetLang, Set<string>> = {
  csharp: new Set(
    'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' '),
  ),
  go: new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' ')),
  typescript: new Set(
    'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with let static yield await implements interface package private protected public'.split(' '),
  ),
  java: new Set(
    // Key words, plus the java.lang.Object methods a record component / accessor cannot be named after (wait, hashCode…).
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield wait notify notifyAll getClass hashCode toString clone finalize'.split(' '),
  ),
  python: new Set(
    'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type'.split(' '),
  ),
};

export function isReserved(lang: TargetLang, name: string): boolean {
  return RESERVED[lang].has(name);
}

/** Escape a reserved identifier: C# `@class`, Go/TS/Java/Python `class_`. */
export function escapeIdent(lang: TargetLang, name: string): string {
  if (!isReserved(lang, name)) return name;
  return lang === 'csharp' ? `@${name}` : `${name}_`;
}

/** Hands out unique names within one scope, suffixing `_2`, `_3` on collisions. */
export class NameScope {
  private used = new Set<string>();
  private readonly caseInsensitive: boolean;
  constructor(reserved: Iterable<string> = [], caseInsensitive = false) {
    this.caseInsensitive = caseInsensitive;
    for (const r of reserved) this.used.add(this.key(r));
  }
  private key(s: string) {
    return this.caseInsensitive ? s.toLowerCase() : s;
  }
  take(name: string): string {
    let n = name;
    let i = 2;
    while (this.used.has(this.key(n))) n = `${name}_${i++}`;
    this.used.add(this.key(n));
    return n;
  }
}

/**
 * `name` with a `_suffix` word, unless its last word already is that suffix: ("Customers", "query") → "Customers_query"
 * (CustomersQuery once styled), but "CustomersQuery" stays as it is instead of becoming CustomersQueryQuery
 * (design-r2-03: a query name that already carries the suffix, e.g. from a tab saved by an older version).
 */
export function withSuffix(name: string, suffix: string): string {
  const words = splitWords(name);
  return words[words.length - 1]?.toLowerCase() === suffix.toLowerCase() ? name : `${name}_${suffix}`;
}

/** Leading words that already make a query name a verb phrase ("ListOrders", "FindCustomer"): no "Get" is added. */
const QUERY_VERBS = new Set(['get', 'list', 'find', 'fetch', 'load', 'read', 'search', 'select', 'query', 'count', 'lookup', 'check', 'calc', 'compute']);

/**
 * Base of a query's function name: "Get" + the query name ("Customers" → GetCustomers → GetCustomersAsync /
 * getCustomers / get_customers), unless the name already starts with a verb ("ListOrders", "GetOrders").
 */
export function queryFnBase(name: string): string {
  const first = splitWords(name)[0]?.toLowerCase() ?? '';
  return QUERY_VERBS.has(first) ? name : `get_${name}`;
}
