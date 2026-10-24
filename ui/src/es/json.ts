// JSON helpers of the Elasticsearch views: lenient parsing of editor text (comments and trailing commas, as Kibana's
// console accepts), pretty printing and path access. Pure.

/** Removes `//` and `/* *\/` comments and trailing commas outside strings. */
export function stripJsonExtras(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string; offset: number };

/** Parses editor JSON (comments/trailing commas allowed). Empty text is `undefined`. */
export function parseLenient(text: string): ParseResult {
  if (!text.trim()) return { ok: true, value: undefined };
  const clean = stripJsonExtras(text);
  try {
    return { ok: true, value: JSON.parse(clean) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /position (\d+)/.exec(msg);
    return { ok: false, error: msg.replace(/^JSON\.parse: /, ''), offset: m ? Number(m[1]) : clean.length };
  }
}

export function pretty(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

/** Pretty-prints JSON text; returns it unchanged when it is not JSON. */
export function prettyText(text: string): string {
  const r = parseLenient(text);
  return r.ok && r.value !== undefined ? pretty(r.value) : text;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Dotted path lookup (`address.city`); arrays map over their items. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (Array.isArray(cur)) cur = cur.map((x) => (isPlainObject(x) ? x[part] : undefined)).filter((x) => x !== undefined);
    else if (isPlainObject(cur)) cur = cur[part];
    else return undefined;
  }
  return cur;
}

/** One-line preview of a value for grid cells. */
export function preview(v: unknown, max = 120): string {
  if (v === undefined) return '';
  if (v === null) return 'null';
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
