// Pure helpers of the colourised snippet code: plain token lines, placeholder ranges and the token/placeholder merge.
import type { Dialect } from '../../api/types';

/** One coloured run of a line: `cls` is the Monaco token class (`mtk4`, `mtk6 mtki`, …) or '' for plain text. */
export interface CodeToken {
  cls: string;
  text: string;
}

/** A run inside a rendered line; `ph` is the index of the placeholder it belongs to, or -1. */
export interface CodeSegment extends CodeToken {
  ph: number;
}

export interface Placeholder {
  start: number;
  end: number;
  /** `$0`: the final cursor position. */
  final: boolean;
}

/** The dialect a snippet is coloured as: its first allowed dialect, T-SQL when it applies to all. */
export function previewDialect(dialects: readonly Dialect[] | null | undefined): Dialect {
  return dialects && dialects.length ? dialects[0] : 'tsql';
}

/** Lines of `text` as single plain tokens (the fallback before Monaco has coloured it). */
export function plainLines(text: string): CodeToken[][] {
  return text.split(/\r\n|\r|\n/).map((line) => (line ? [{ cls: '', text: line.replace(/\t/g, '    ') }] : []));
}

// $1, ${1}, ${1:default} (one nesting level: ${1:a ${2:b}}), ${1|a,b|}; \$ is a literal dollar.
const PLACEHOLDER = /\$\{\d+(?::(?:[^{}]|\{[^{}]*\})*)?\}|\$\{\d+\|[^}]*\|\}|\$\d+/g;

/** Placeholder ranges of one line (a backslash-escaped `\$` is not one). */
export function placeholders(line: string): Placeholder[] {
  const out: Placeholder[] = [];
  PLACEHOLDER.lastIndex = 0;
  for (let m = PLACEHOLDER.exec(line); m; m = PLACEHOLDER.exec(line)) {
    let backslashes = 0;
    for (let i = m.index - 1; i >= 0 && line[i] === '\\'; i--) backslashes++;
    if (backslashes % 2 === 1) {
      PLACEHOLDER.lastIndex = m.index + 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length, final: /^\$(0|\{0[}:|])/.test(m[0]) });
  }
  return out;
}

/** Splits a line's tokens at placeholder boundaries and tags each run with its placeholder index. */
export function segmentLine(tokens: readonly CodeToken[], phs: readonly Placeholder[]): CodeSegment[] {
  const out: CodeSegment[] = [];
  let pos = 0;
  for (const t of tokens) {
    let i = 0;
    while (i < t.text.length) {
      const at = pos + i;
      const k = phs.findIndex((p) => at >= p.start && at < p.end);
      // run to the next boundary: the end of this placeholder, or the start of the next one
      let stop = t.text.length;
      if (k >= 0) stop = Math.min(stop, phs[k].end - pos);
      else {
        const next = phs.find((p) => p.start > at);
        if (next) stop = Math.min(stop, next.start - pos);
      }
      const text = t.text.slice(i, stop);
      const last = out[out.length - 1];
      if (last && last.cls === t.cls && last.ph === k) last.text += text;
      else out.push({ cls: t.cls, text, ph: k });
      i = stop;
    }
    pos += t.text.length;
  }
  return out;
}
