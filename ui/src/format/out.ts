// Line-oriented output writer for the formatter. The layout engine asks for line breaks (`newline(indent)`) and
// appends pieces (`put`); the writer materialises breaks lazily so pending comments land at the right indent.
// It never writes trailing whitespace and tracks the visual column for line-width decisions.

export interface OutOptions {
  indentSize: number;
  useTabs: boolean;
  /** Line break the writer inserts (tokens keep their own internal line breaks). */
  eol?: string;
}

export class Out {
  private readonly parts: string[] = [];
  /** Text of the current line after its indentation. */
  private cur = '';
  /** Indent level of the current line. */
  private curIndent = 0;
  /** A break was requested before the next piece (indent level). */
  private pendingIndent: number | null = null;
  private pendingBlank = 0;
  /** Number of physical lines already finished (for "did this statement span lines"). */
  private finished = 0;
  /** Visual column of the end of the current line, -1 = not computed. */
  private colCache = -1;
  /** The current line started inside a multi-line verbatim token (its column is not indent based). */
  private rawLine = false;
  private readonly unit: string;
  private readonly opts: OutOptions;

  constructor(opts: OutOptions) {
    this.opts = opts;
    this.unit = opts.useTabs ? '\t' : ' '.repeat(opts.indentSize);
  }

  /** Nothing written yet. */
  get isEmpty(): boolean {
    return this.parts.length === 0 && this.cur === '';
  }
  /** The current line has no content yet (or a break is pending). */
  get atLineStart(): boolean {
    return this.cur === '' || this.pendingIndent !== null;
  }
  /** Content lines begun so far (blank lines excluded): measures how many lines a statement produced. */
  get linesStarted(): number {
    return this.started;
  }
  private started = 0;
  /** Indent of a requested-but-not-yet-materialised break, or null. */
  get pending(): number | null {
    return this.pendingIndent;
  }
  /** Indent level of the line the next piece goes to. */
  get lineIndent(): number {
    return this.pendingIndent ?? this.curIndent;
  }
  get lineCount(): number {
    return this.finished + (this.cur === '' ? 0 : 1);
  }
  /** Column (0-based, indentation included) where the next piece would start, before its separating space. */
  get column(): number {
    if (this.pendingIndent !== null) return this.pendingIndent * this.opts.indentSize;
    if (this.colCache >= 0) return this.colCache;
    const nl = this.cur.lastIndexOf('\n');
    const base = this.rawLine || nl >= 0 ? 0 : this.curIndent * this.opts.indentSize;
    this.colCache = base + (nl >= 0 ? this.cur.length - nl - 1 : this.cur.length);
    return this.colCache;
  }

  /** The next piece starts a new line at `indent` (no-op on an empty current line except for the indent). */
  newline(indent: number): void {
    this.pendingIndent = Math.max(0, indent);
  }

  /** Cancel a pending break request (the next piece continues the current line). */
  cancelNewline(): void {
    if (this.cur !== '') this.pendingIndent = null;
  }

  /** At least `n` blank lines before the next line (ignored at the start of the output). */
  blank(n: number): void {
    if (n > this.pendingBlank) this.pendingBlank = n;
  }

  private flushLine(): void {
    if (this.cur === '') return;
    const prefix = this.rawLine ? '' : this.unit.repeat(this.curIndent);
    this.parts.push(prefix + this.cur);
    this.finished += 1 + countNl(this.cur);
    this.cur = '';
    this.rawLine = false;
    this.colCache = -1;
  }

  private materialise(): void {
    if (this.pendingIndent === null && this.cur !== '') return;
    const indent = this.pendingIndent ?? this.curIndent;
    if (this.cur !== '') this.flushLine();
    if (this.parts.length > 0 && this.pendingBlank > 0) {
      for (let i = 0; i < this.pendingBlank; i++) this.parts.push('');
      this.finished += this.pendingBlank;
    }
    this.pendingBlank = 0;
    this.curIndent = indent;
    this.pendingIndent = null;
  }

  /** Append `text`; `space` = separate it from the previous piece on the same line. */
  put(text: string, space: boolean): void {
    if (this.cur === '' || this.pendingIndent !== null) this.started++;
    this.materialise();
    this.started += countNl(text);
    if (this.cur !== '' && space) this.cur += ' ';
    this.cur += text;
    this.colCache = -1;
  }

  /** Text produced so far, without a trailing newline. */
  toString(): string {
    const lines = this.parts.slice();
    if (this.cur !== '') lines.push((this.rawLine ? '' : this.unit.repeat(this.curIndent)) + this.cur);
    return lines.join(this.opts.eol ?? '\n');
  }
}

function countNl(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}
