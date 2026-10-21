// redis-cli argument rules (sdssplitargs), the UI twin of engine RedisArgs: used for completion context, SELECT
// tracking, history and the read-only hint. The engine parses the raw line itself (exact bytes for \xHH).

export class ArgsError extends Error {}

const SPACE = /[ \n\r\t\v\f]/;
const HEX = /^[0-9a-fA-F]{2}$/;

/** Splits a command line; throws ArgsError on unbalanced quotes or a closing quote not followed by a space. */
export function parseArgs(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && SPACE.test(line[i])) i++;
    if (i >= n) return out;
    let cur = '';
    let inDouble = false;
    let inSingle = false;
    for (;;) {
      if (inDouble) {
        if (i >= n) throw new ArgsError('Invalid argument(s): unbalanced double quotes');
        const c = line[i];
        if (c === '\\' && line[i + 1] === 'x' && HEX.test(line.slice(i + 2, i + 4))) {
          cur += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16));
          i += 4;
          continue;
        }
        if (c === '\\' && i + 1 < n) {
          const e = line[i + 1];
          cur += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e;
          i += 2;
          continue;
        }
        if (c === '"') {
          if (i + 1 < n && !SPACE.test(line[i + 1])) throw new ArgsError('Invalid argument(s): closing quote must be followed by a space');
          i++;
          break;
        }
        cur += c;
        i++;
      } else if (inSingle) {
        if (i >= n) throw new ArgsError('Invalid argument(s): unbalanced single quotes');
        const c = line[i];
        if (c === '\\' && line[i + 1] === "'") {
          cur += "'";
          i += 2;
          continue;
        }
        if (c === "'") {
          if (i + 1 < n && !SPACE.test(line[i + 1])) throw new ArgsError('Invalid argument(s): closing quote must be followed by a space');
          i++;
          break;
        }
        cur += c;
        i++;
      } else {
        if (i >= n || SPACE.test(line[i])) break;
        const c = line[i];
        if (c === '"') inDouble = true;
        else if (c === "'") inSingle = true;
        else cur += c;
        i++;
      }
    }
    out.push(cur);
  }
}

/** Like parseArgs but never throws (null on a quoting error). */
export function tryParseArgs(line: string): string[] | null {
  try {
    return parseArgs(line);
  } catch {
    return null;
  }
}

/** Quotes an argument when redis-cli needs it to read back the same text. */
export function quoteArg(value: string): string {
  if (value.length > 0 && /^[\x21\x23-\x26\x28-\x5b\x5d-\x7e -￿]+$/.test(value)) return value;
  let s = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') s += '\\\\';
    else if (ch === '"') s += '\\"';
    else if (ch === '\n') s += '\\n';
    else if (ch === '\r') s += '\\r';
    else if (ch === '\t') s += '\\t';
    else if (code < 0x20 || code === 0x7f) s += `\\x${code.toString(16).padStart(2, '0')}`;
    else s += ch;
  }
  return `${s}"`;
}

export function joinArgs(args: readonly string[]): string {
  return args.map(quoteArg).join(' ');
}

/** The command words of a line (for completion): the finished arguments and the one being typed. */
export interface LineContext {
  /** Arguments before the caret (complete words). */
  args: string[];
  /** The partial word at the caret ('' after a space). */
  current: string;
  /** The caret is inside an open quote. */
  inQuote: '"' | "'" | null;
  /** Offset in the line where `current` starts (replacement range). */
  start: number;
}

export function lineContext(textBeforeCaret: string): LineContext {
  const args: string[] = [];
  let i = 0;
  const n = textBeforeCaret.length;
  let start = 0;
  let cur = '';
  let quote: '"' | "'" | null = null;
  let inWord = false;
  while (i < n) {
    const c = textBeforeCaret[i];
    if (quote) {
      if (c === '\\' && i + 1 < n) {
        cur += textBeforeCaret[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      else cur += c;
      i++;
      continue;
    }
    if (SPACE.test(c)) {
      if (inWord) {
        args.push(cur);
        cur = '';
        inWord = false;
      }
      i++;
      continue;
    }
    if (!inWord) {
      inWord = true;
      start = i;
    }
    if (c === '"' || c === "'") quote = c;
    else cur += c;
    i++;
  }
  if (!inWord) start = n;
  return { args, current: cur, inQuote: quote, start };
}

/** Workbench lines that are commands: blank lines and `#` / `//` comments are skipped. */
export function commandLines(text: string): { line: string; lineNumber: number }[] {
  const out: { line: string; lineNumber: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    out.push({ line: t, lineNumber: i + 1 });
  });
  return out;
}
