// Tiny indentation-aware text builder used by every language generator. Pure: no DOM, React or Monaco.

export class Writer {
  private lines: string[] = [];
  private level = 0;
  private readonly unit: string;

  constructor(unit = '    ') {
    this.unit = unit;
  }

  /** Append one line at the current indent (empty string = blank line). */
  line(text = ''): this {
    this.lines.push(text ? this.unit.repeat(this.level) + text : '');
    return this;
  }

  /** Append several lines (a multi-line string is split) at the current indent. */
  lines_(text: string | string[]): this {
    for (const l of Array.isArray(text) ? text : text.split('\n')) this.line(l);
    return this;
  }

  /** A blank line unless the previous line is already blank or an opening brace. */
  blank(): this {
    const last = this.lines[this.lines.length - 1];
    if (last !== undefined && last.trim() !== '' && !/[{(\[:]$/.test(last.trimEnd())) this.lines.push('');
    return this;
  }

  /** Exactly `n` blank lines before the next line (PEP 8 wants two between top-level definitions). */
  blanks(n: number): this {
    while (this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
    for (let i = 0; i < n; i++) this.lines.push('');
    return this;
  }

  indent(): this {
    this.level++;
    return this;
  }

  dedent(): this {
    this.level = Math.max(0, this.level - 1);
    return this;
  }

  /** `open` line, indented body, `close` line. */
  block(open: string, body: (w: this) => void, close = '}'): this {
    this.line(open);
    this.indent();
    body(this);
    this.dedent();
    if (close) this.line(close);
    return this;
  }

  /** Allman-style block (C#): `open`, `{` on its own line, indented body, `close`. */
  allman(open: string, body: (w: this) => void, close = '}'): this {
    this.line(open);
    this.line('{');
    this.indent();
    body(this);
    this.dedent();
    this.line(close);
    return this;
  }

  /** Lines produced by another writer, re-indented to the current level. */
  append(other: Writer | string): this {
    const text = typeof other === 'string' ? other : other.toString();
    for (const l of text.split('\n')) this.line(l);
    return this;
  }

  get isEmpty(): boolean {
    return this.lines.length === 0;
  }

  toString(): string {
    // Trim trailing blank lines.
    const out = [...this.lines];
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
  }
}

/** Escape text for a double-quoted string literal in C-family languages. */
export function dq(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

/** Escape text for a single-quoted string literal (TS/JS/Python). */
export function sq(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
}

/** Comment-safe single line (no line breaks, no comment terminators). */
export function commentText(s: string | null | undefined): string {
  return (s ?? '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
}
