// Redis glob patterns (SCAN MATCH, PSUBSCRIBE, KEYS): `*`, `?`, `[abc]`, `[^a]`, `[a-z]`, `\x` escapes.
// Used for client-side filtering of cached keys and by the mock engine.

export function globToRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '\\' && i + 1 < pattern.length) re += escape(pattern[++i]);
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close < 0) {
        re += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, close);
      const negate = body.startsWith('^');
      if (negate) body = body.slice(1);
      re += `[${negate ? '^' : ''}${body.replace(/[\]\\]/g, (m) => `\\${m}`)}]`;
      i = close;
    } else re += escape(c);
  }
  return new RegExp(`${re}$`);
}

function escape(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

export function globMatch(pattern: string, text: string): boolean {
  return globToRegExp(pattern).test(text);
}

/** True when the pattern has glob characters (otherwise it names one key). */
export function hasGlob(pattern: string): boolean {
  return /(^|[^\\])[*?[]/.test(pattern);
}
