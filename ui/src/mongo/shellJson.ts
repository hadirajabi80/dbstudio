// Shell JSON (docs/PLAN-M2.md 6.3): the mongosh-flavoured JSON of the query bar, the stage editors and the document
// editor. Mirrors the engine's ShellJson.cs grammar so the UI can validate before sending, split pipelines, feed
// the code exporter and know where the caret is for completion:
//   JSON + comments + trailing commas + single-quoted strings + unquoted keys (letters, digits, _ $ .) +
//   regex literals + NaN/Infinity/undefined + helpers ObjectId() ISODate() Date() NumberLong() Long() NumberInt()
//   Int32() NumberDecimal() Decimal128() Double() BinData() HexData() UUID() MD5() Timestamp() MinKey MaxKey RegExp()
//   Code() DBRef(), optional `new`, plus canonical/relaxed EJSON wrappers ({"$oid": …}).
import { B, base64ToHex, fromEjson, newObjectId, numberValue, toEjsonJson, type BsonEntry, type BsonValue } from './bson';

export class ShellJsonError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly col: number;
  constructor(message: string, offset: number, text: string) {
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const col = offset - before.lastIndexOf('\n');
    super(`${message} (line ${line}, column ${col})`);
    this.offset = offset;
    this.line = line;
    this.col = col;
  }
}

export type TokKind = 'punct' | 'string' | 'number' | 'ident' | 'regex' | 'comment' | 'eof';

export interface Token {
  kind: TokKind;
  /** Punctuation char, string value (unescaped), identifier name, number text, regex body. */
  value: string;
  start: number;
  end: number;
  /** Regex flags. */
  flags?: string;
  /** Unterminated string/comment/regex (completion inside an open string). */
  open?: boolean;
  /** Quote char of a string. */
  quote?: string;
}

const PUNCT = '{}[]():,';

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$]/.test(c);
}
function isIdentChar(c: string): boolean {
  return /[\w$.]/.test(c);
}

/** Tokenizes shell JSON. Lenient: never throws; unterminated tokens are flagged `open`. */
export function tokenize(text: string, keepComments = false): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = text.length;
  const prevSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) if (out[k].kind !== 'comment') return out[k];
    return undefined;
  };
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      const end = e < 0 ? n : e;
      if (keepComments) out.push({ kind: 'comment', value: text.slice(i, end), start: i, end });
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      if (keepComments) out.push({ kind: 'comment', value: text.slice(i, end), start: i, end, open: e < 0 });
      i = end;
      continue;
    }
    if (PUNCT.includes(c)) {
      out.push({ kind: 'punct', value: c, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      let closed = false;
      while (j < n) {
        const d = text[j];
        if (d === c) {
          closed = true;
          j++;
          break;
        }
        if (d === '\n') break;
        if (d === '\\' && j + 1 < n) {
          const e = text[j + 1];
          j += 2;
          switch (e) {
            case 'n': s += '\n'; break;
            case 't': s += '\t'; break;
            case 'r': s += '\r'; break;
            case 'b': s += '\b'; break;
            case 'f': s += '\f'; break;
            case 'v': s += '\v'; break;
            case '0': s += '\0'; break;
            case 'u': {
              const hex = text.slice(j, j + 4);
              if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                s += String.fromCharCode(parseInt(hex, 16));
                j += 4;
              } else s += 'u';
              break;
            }
            case 'x': {
              const hex = text.slice(j, j + 2);
              if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                s += String.fromCharCode(parseInt(hex, 16));
                j += 2;
              } else s += 'x';
              break;
            }
            default: s += e;
          }
          continue;
        }
        s += d;
        j++;
      }
      out.push({ kind: 'string', value: s, start: i, end: j, open: !closed, quote: c });
      i = j;
      continue;
    }
    if (c === '/') {
      // a regex literal where a value is expected (after : , [ ( or at the start)
      const p = prevSignificant();
      if (!p || (p.kind === 'punct' && ':,[('.includes(p.value))) {
        let j = i + 1;
        let body = '';
        let inClass = false;
        let closed = false;
        while (j < n && text[j] !== '\n') {
          const d = text[j];
          if (d === '\\' && j + 1 < n) {
            body += d + text[j + 1];
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            closed = true;
            j++;
            break;
          }
          body += d;
          j++;
        }
        let flags = '';
        while (j < n && /[a-z]/i.test(text[j])) flags += text[j++];
        out.push({ kind: 'regex', value: body.replace(/\\\//g, '/'), flags, start: i, end: j, open: !closed });
        i = j;
        continue;
      }
    }
    if (/[0-9]/.test(c) || ((c === '-' || c === '+' || c === '.') && /[0-9.]/.test(text[i + 1] ?? ''))) {
      const m = /^[+-]?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(text.slice(i));
      const len = m ? m[0].length : 1;
      out.push({ kind: 'number', value: text.slice(i, i + len), start: i, end: i + len });
      i += len;
      continue;
    }
    if (c === '-' && text.startsWith('Infinity', i + 1)) {
      out.push({ kind: 'ident', value: '-Infinity', start: i, end: i + 9 });
      i += 9;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentChar(text[j])) j++;
      out.push({ kind: 'ident', value: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    // unknown character: emit as punct so the parser reports it
    out.push({ kind: 'punct', value: c, start: i, end: i + 1 });
    i++;
  }
  out.push({ kind: 'eof', value: '', start: n, end: n });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Parser

const EJSON_KEYS = new Set([
  '$oid', '$date', '$numberLong', '$numberInt', '$numberDouble', '$numberDecimal', '$binary', '$uuid', '$regularExpression',
  '$timestamp', '$minKey', '$maxKey', '$undefined', '$symbol', '$code', '$dbPointer',
]);

class Parser {
  private toks: Token[];
  private p = 0;
  private text: string;

  constructor(text: string) {
    this.text = text;
    this.toks = tokenize(text);
  }

  private get t(): Token {
    return this.toks[this.p];
  }

  private fail(msg: string, tok: Token = this.t): never {
    throw new ShellJsonError(msg, tok.start, this.text);
  }

  private expect(ch: string): Token {
    const t = this.t;
    if (t.kind !== 'punct' || t.value !== ch) this.fail(t.kind === 'eof' ? `Expected '${ch}' but the text ended` : `Expected '${ch}'`);
    this.p++;
    return t;
  }

  private isPunct(ch: string): boolean {
    return this.t.kind === 'punct' && this.t.value === ch;
  }

  parseTop(): BsonValue {
    if (this.t.kind === 'eof') return B.doc([]);
    const v = this.value();
    if ((this.t.kind as TokKind) !== 'eof') this.fail('Unexpected text after the value');
    return v;
  }

  value(): BsonValue {
    const t = this.t;
    switch (t.kind) {
      case 'punct':
        if (t.value === '{') return this.object();
        if (t.value === '[') return this.array();
        return this.fail(`Unexpected '${t.value}'`);
      case 'string':
        if (t.open) this.fail('Unterminated string');
        this.p++;
        return { t: 'string', v: t.value };
      case 'number':
        this.p++;
        return parseNumber(t.value);
      case 'regex':
        if (t.open) this.fail('Unterminated regular expression');
        this.p++;
        return { t: 'regex', pattern: t.value, flags: sortFlags(t.flags ?? '') };
      case 'ident':
        return this.ident();
      case 'eof':
        return this.fail('Expected a value but the text ended');
      default:
        return this.fail('Unexpected token');
    }
  }

  private object(): BsonValue {
    const open = this.expect('{');
    const entries: BsonEntry[] = [];
    while (!this.isPunct('}')) {
      const kt = this.t;
      let key: string;
      if (kt.kind === 'string') {
        if (kt.open) this.fail('Unterminated string');
        key = kt.value;
      } else if (kt.kind === 'ident') key = kt.value;
      else if (kt.kind === 'number') key = kt.value;
      else if (kt.kind === 'eof') this.fail("Expected '}' but the text ended", open);
      else this.fail('Expected a field name');
      this.p++;
      this.expect(':');
      entries.push([key!, this.value()]);
      if (this.isPunct(',')) {
        this.p++;
        continue;
      }
      if (!this.isPunct('}')) this.fail((this.t.kind as TokKind) === 'eof' ? "Expected '}' but the text ended" : "Expected ',' or '}'");
    }
    this.p++;
    if (entries.length > 0 && entries.every(([k]) => EJSON_KEYS.has(k) || (entries.length === 2 && k === '$scope'))) {
      try {
        const w = fromEjson(Object.fromEntries(entries.map(([k, v]) => [k, toEjsonJson(v)])));
        if (w.t !== 'object') return w;
      } catch {
        /* keep as document */
      }
    }
    return { t: 'object', v: entries };
  }

  private array(): BsonValue {
    const open = this.expect('[');
    const items: BsonValue[] = [];
    while (!this.isPunct(']')) {
      if (this.t.kind === 'eof') this.fail("Expected ']' but the text ended", open);
      items.push(this.value());
      if (this.isPunct(',')) {
        this.p++;
        continue;
      }
      if (!this.isPunct(']')) this.fail((this.t.kind as TokKind) === 'eof' ? "Expected ']' but the text ended" : "Expected ',' or ']'");
    }
    this.p++;
    return { t: 'array', v: items };
  }

  private args(): BsonValue[] {
    if (!this.isPunct('(')) return [];
    this.p++;
    const out: BsonValue[] = [];
    while (!this.isPunct(')')) {
      if (this.t.kind === 'eof') this.fail("Expected ')' but the text ended");
      out.push(this.value());
      if (this.isPunct(',')) {
        this.p++;
        continue;
      }
      if (!this.isPunct(')')) this.fail("Expected ',' or ')'");
    }
    this.p++;
    return out;
  }

  private ident(): BsonValue {
    const t = this.t;
    this.p++;
    let name = t.value;
    if (name === 'new') {
      if (this.t.kind !== 'ident') this.fail('Expected a constructor after new');
      name = this.t.value;
      this.p++;
    }
    switch (name) {
      case 'true': return B.bool(true);
      case 'false': return B.bool(false);
      case 'null': return B.null();
      case 'undefined': return { t: 'undefined' };
      case 'NaN': return B.double(NaN);
      case 'Infinity': return B.double(Infinity);
      case '-Infinity': return B.double(-Infinity);
      case 'MinKey': this.args(); return { t: 'minKey' };
      case 'MaxKey': this.args(); return { t: 'maxKey' };
      case 'Date.now': this.args(); return B.date(Date.now());
    }
    if (!this.isPunct('(')) this.fail(`Unknown identifier '${name}' (strings need quotes)`, t);
    const a = this.args();
    const str = (i: number, what: string): string => {
      const v = a[i];
      if (!v || v.t !== 'string') this.fail(`${name}() expects ${what}`, t);
      return v.v;
    };
    const num = (i: number, what: string): number => {
      const v = a[i];
      if (v && (v.t === 'int' || v.t === 'double')) return v.v;
      if (v && v.t === 'long') return Number(v.v);
      if (v && v.t === 'string' && v.v.trim() !== '' && !Number.isNaN(Number(v.v))) return Number(v.v);
      return this.fail(`${name}() expects ${what}`, t);
    };
    switch (name) {
      case 'ObjectId': {
        if (a.length === 0) return B.oid(newObjectId());
        const h = str(0, 'a 24-character hex string');
        if (!/^[0-9a-fA-F]{24}$/.test(h)) this.fail('ObjectId() expects a 24-character hex string', t);
        return B.oid(h);
      }
      case 'ISODate': case 'Date': {
        if (a.length === 0) return B.date(Date.now());
        const v = a[0];
        if (v.t === 'string') {
          const ms = parseIsoDate(v.v);
          if (ms === null) this.fail(`${name}() cannot parse "${v.v}"`, t);
          return B.date(ms);
        }
        return B.date(num(0, 'a date string or milliseconds'));
      }
      case 'NumberLong': case 'Long': {
        const v = a[0];
        const s = v?.t === 'string' ? v.v.trim() : v?.t === 'int' || v?.t === 'long' ? String(v.v) : v?.t === 'double' && Number.isInteger(v.v) ? String(v.v) : '';
        if (!/^[+-]?\d+$/.test(s)) this.fail(`${name}() expects an integer`, t);
        return B.long(BigInt(s).toString());
      }
      case 'NumberInt': case 'Int32': {
        const n = Math.trunc(num(0, 'an integer'));
        return B.int(n);
      }
      case 'NumberDecimal': case 'Decimal128': {
        const v = a[0];
        const s = v?.t === 'string' ? v.v : v?.t === 'int' || v?.t === 'double' ? String(v.v) : v?.t === 'long' ? v.v : '';
        if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$|^[+-]?(Infinity|NaN|Inf)$/i.test(s.trim())) this.fail(`${name}() expects a decimal number`, t);
        return B.decimal(s.trim());
      }
      case 'Double': return B.double(num(0, 'a number'));
      case 'BinData': {
        const sub = Math.trunc(num(0, 'a subtype and a base64 string'));
        const b64 = str(1, 'a subtype and a base64 string');
        return B.bin(b64, sub.toString(16).padStart(2, '0'));
      }
      case 'HexData': {
        const sub = Math.trunc(num(0, 'a subtype and a hex string'));
        const hex = str(1, 'a subtype and a hex string');
        return B.bin(hexToB64(hex), sub.toString(16).padStart(2, '0'));
      }
      case 'UUID': {
        if (a.length === 0) return B.bin(hexToB64(randomUuidHex()), '04');
        const h = str(0, 'a UUID string').replace(/-/g, '');
        if (!/^[0-9a-fA-F]{32}$/.test(h)) this.fail('UUID() expects a 32-digit hex UUID', t);
        return B.bin(hexToB64(h), '04');
      }
      case 'MD5': return B.bin(hexToB64(str(0, 'a hex string')), '05');
      case 'Timestamp': {
        if (a[0]?.t === 'object') {
          const o = Object.fromEntries(a[0].v);
          return { t: 'timestamp', ts: Number(scalarNum(o.t)), inc: Number(scalarNum(o.i)) };
        }
        return { t: 'timestamp', ts: num(0, 'seconds and an increment'), inc: a.length > 1 ? num(1, 'seconds and an increment') : 0 };
      }
      case 'RegExp': return { t: 'regex', pattern: str(0, 'a pattern'), flags: sortFlags(a[1]?.t === 'string' ? a[1].v : '') };
      case 'Code': return { t: 'javascript', v: str(0, 'source text') };
      case 'DBRef': return B.doc([['$ref', B.str(str(0, 'a collection and an id'))], ['$id', a[1] ?? B.null()]]);
      default:
        return this.fail(`Unknown function ${name}()`, t);
    }
  }
}

function scalarNum(v: BsonValue | undefined): number {
  if (!v) return 0;
  if (v.t === 'int' || v.t === 'double') return v.v;
  if (v.t === 'long') return Number(v.v);
  return 0;
}

function sortFlags(f: string): string {
  return [...new Set(f.split(''))].sort().join('');
}

function hexToB64(hex: string): string {
  let bin = '';
  for (let i = 0; i + 1 < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

function randomUuidHex(): string {
  let h = '';
  for (let i = 0; i < 32; i++) h += Math.floor(Math.random() * 16).toString(16);
  return `${h.slice(0, 12)}4${h.slice(13, 16)}${'89ab'[Math.floor(Math.random() * 4)]}${h.slice(17)}`;
}

/** ISO-8601 (date, date-time, with/without zone) → ms UTC; null when unparseable. */
export function parseIsoDate(s: string): number | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return Date.parse(`${t}T00:00:00Z`);
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(t) ? t : `${t}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? null : ms;
}

function parseNumber(s: string): BsonValue {
  if (/^[+-]?0[xX]/.test(s)) return numberValue(Number(s.replace(/^\+/, '')));
  if (/[.eE]/.test(s)) return B.double(Number(s));
  const n = Number(s);
  if (Number.isSafeInteger(n)) return numberValue(n);
  try {
    const big = BigInt(s.replace(/^\+/, ''));
    if (big >= -(2n ** 63n) && big < 2n ** 63n) return B.long(big.toString());
  } catch {
    /* fall through */
  }
  return B.double(n);
}

/** Parses shell JSON text; empty text is `{}`. Throws ShellJsonError with the position. */
export function parseShell(text: string): BsonValue {
  return new Parser(text).parseTop();
}

/** Parses a document (`{…}`); a bare `field: value` list is accepted and wrapped in braces. */
export function parseShellDoc(text: string): Extract<BsonValue, { t: 'object' }> {
  const trimmed = text.trim();
  if (trimmed && !trimmed.startsWith('{') && /^[\w$."']+\s*:/.test(trimmed)) return parseShellDoc(`{${text}}`);
  const v = parseShell(text);
  if (v.t !== 'object') throw new ShellJsonError('Expected a document { … }', 0, text);
  return v;
}

/** Parses a pipeline `[ {…}, {…} ]`. */
export function parseShellArray(text: string): BsonValue[] {
  const v = parseShell(text.trim() ? text : '[]');
  if (v.t !== 'array') throw new ShellJsonError('Expected an array [ … ]', 0, text);
  return v.v;
}

/** Validation for the editors: null when the text parses, else the error. */
export function checkShell(text: string, kind: 'doc' | 'value' | 'array' = 'doc'): ShellJsonError | null {
  try {
    if (kind === 'doc') parseShellDoc(text);
    else if (kind === 'array') parseShellArray(text);
    else parseShell(text);
    return null;
  } catch (e) {
    if (e instanceof ShellJsonError) return e;
    return new ShellJsonError(e instanceof Error ? e.message : String(e), 0, text);
  }
}

/** True when the text is empty or `{}` (an "everything" filter). */
export function isEmptyDocText(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return true;
  try {
    const v = parseShell(text);
    return v.t === 'object' && v.v.length === 0;
  } catch {
    return false;
  }
}

export { base64ToHex };
