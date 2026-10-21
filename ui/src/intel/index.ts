// Public API of the DbStudio IntelliSense engine (PLAN 4.12). Pure TypeScript; no DOM/React/Monaco.
import type { CatalogObject, CatalogSnapshot } from '../api/types';
import type {
  CompletionItem, CompletionResult, DefinitionResult, Diagnostic, Dialect, HoverInfo, IntelOptions, SignatureHelpInfo,
  SqlBatch, StatementInfo, StatementKind, Token,
} from './types';
import { getSpec, type DialectSpec } from './dialect';
import { lineStarts, positionAt, relex, tokenize, type TextChange } from './lexer/lexer';
import { splitStatements, type SplitResult, type SplitStatement } from './split/splitter';
import { classifyTokens, isDestructive } from './split/classify';
import { buildModel } from './parse/partial-parser';
import type { StatementModel, TempTableDef, VarDef } from './parse/statement-model';
import { CatalogIndex } from './catalog/index';
import { Binder, type DocSymbols } from './catalog/binder';
import { detectContext, findCall } from './context/context';
import { complete as runComplete, type ExtraCompletionSource } from './complete/completer';
import { UsageStore } from './complete/ranker';
import { signatureHelp as runSignature } from './signature/signature';
import { symbolAt } from './hover/symbol';
import { hoverFor } from './hover/hover';
import { definitionFor } from './definition/definition';
import { lexicalDiagnostics, statementDiagnostics, type RawDiagnostic } from './diagnostics/soft-diagnostics';

export * from './types';
export type { DialectSpec } from './dialect';
export { getSpec } from './dialect';
export { tokenize, lexLine, type LexState, type LineToken } from './lexer/lexer';
export { isDestructive } from './split/classify';
export { needsQuoting, quoteIdent } from './complete/format';
export { matchScore, sortTextFor } from './complete/ranker';
export type { ExtraCompletionSource, CompleteEnv } from './complete/completer';
export type { CursorContext } from './context/context';

export interface Intel {
  readonly dialect: Dialect;
  readonly spec: DialectSpec;
  setCatalog(snapshot: CatalogSnapshot | null): void;
  setOptions(opts: Partial<IntelOptions>): void;
  getOptions(): IntelOptions;
  setDocument(uri: string, text: string): void;
  applyEdit(uri: string, change: TextChange): void;
  closeDocument(uri: string): void;
  getText(uri: string): string;
  tokens(uri: string): Token[];
  statements(uri: string): StatementInfo[];
  statementAt(uri: string, offset: number): StatementInfo | null;
  batchesFor(uri: string, range?: [number, number]): SqlBatch[];
  complete(uri: string, offset: number, trigger?: string): CompletionResult;
  resolveItem(item: CompletionItem): CompletionItem;
  hover(uri: string, offset: number): HoverInfo | null;
  signatureHelp(uri: string, offset: number): SignatureHelpInfo | null;
  definition(uri: string, offset: number): DefinitionResult | null;
  softDiagnostics(uri: string): Diagnostic[];
  classify(sql: string): StatementKind;
  recordAccepted(item: Pick<CompletionItem, 'usageKey'>): void;
  setUsage(usage: Record<string, number> | undefined): void;
  getUsage(): Record<string, number>;
  /** Oracle PUBLIC synonym lazy resolution hook. */
  setPublicSynonymResolver(fn: ((name: string) => Promise<CatalogObject | null>) | null): void;
  /** Called when completion needs a schema that is not loaded. */
  setSchemaRequester(fn: ((schema: string) => void) | null): void;
  /** Catalog-derived state changed asynchronously (e.g. a PUBLIC synonym resolved). */
  onDidChange(fn: () => void): () => void;
  /** Extra completion sources (WP-H snippets / postfix templates), consulted on every completion. */
  setExtraCompletionSources(sources: readonly ExtraCompletionSource[]): void;
  /** Statement model (exposed for tests and tooling). */
  modelAt(uri: string, offset: number): StatementModel | null;
}

export const DEFAULT_OPTIONS: IntelOptions = {
  keywordCase: 'upper',
  identifierCase: 'asIs',
  qualifyObjects: 'nonDefaultSchema',
  qualifyColumns: 'ambiguous',
  blankLineSplitsStatements: true,
  runNextStatementOnBlank: false,
  aliasStyle: 'initials',
  maxColumnsWithoutFrom: 3000,
};

interface Doc {
  uri: string;
  text: string;
  tokens: Token[];
  lines: number[];
  split: SplitResult | null;
  models: Map<string, StatementModel>;
  diags: Diagnostic[] | null;
}

function modelKey(st: SplitStatement): string {
  return st.start + '\u0000' + st.text;
}

class IntelImpl implements Intel {
  readonly dialect: Dialect;
  readonly spec: DialectSpec;
  private opts: IntelOptions;
  private readonly docs = new Map<string, Doc>();
  private readonly index: CatalogIndex;
  private readonly usage = new UsageStore();
  private readonly listeners = new Set<() => void>();
  private extraSources: readonly ExtraCompletionSource[] = [];

  constructor(dialect: Dialect, opts?: Partial<IntelOptions>) {
    this.dialect = dialect;
    this.spec = getSpec(dialect);
    this.opts = { ...DEFAULT_OPTIONS, blankLineSplitsStatements: dialect !== 'sqlite' && dialect !== 'pgsql', ...opts };
    this.index = new CatalogIndex(this.spec);
    this.index.onChange = () => {
      for (const d of this.docs.values()) d.diags = null;
      for (const l of this.listeners) l();
    };
  }

  // ---------------------------------------------------------------- configuration

  setCatalog(snapshot: CatalogSnapshot | null): void {
    if (this.index.setSnapshot(snapshot)) for (const d of this.docs.values()) d.diags = null;
  }
  setOptions(opts: Partial<IntelOptions>): void {
    const before = this.opts.blankLineSplitsStatements;
    this.opts = { ...this.opts, ...opts };
    if (before !== this.opts.blankLineSplitsStatements) for (const d of this.docs.values()) { d.split = null; d.diags = null; }
  }
  getOptions(): IntelOptions { return { ...this.opts }; }
  setUsage(usage: Record<string, number> | undefined): void { this.usage.set(usage); }
  setExtraCompletionSources(sources: readonly ExtraCompletionSource[]): void { this.extraSources = sources; }
  getUsage(): Record<string, number> { return this.usage.toRecord(); }
  setPublicSynonymResolver(fn: ((name: string) => Promise<CatalogObject | null>) | null): void { this.index.publicResolver = fn; }
  setSchemaRequester(fn: ((schema: string) => void) | null): void { this.index.schemaRequester = fn; }
  onDidChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------------------------------------------------------------- documents

  setDocument(uri: string, text: string): void {
    const prev = this.docs.get(uri);
    if (prev && prev.text === text) return;
    this.docs.set(uri, { uri, text, tokens: tokenize(text, this.spec), lines: lineStarts(text), split: null, models: prev?.models ?? new Map(), diags: null });
  }

  applyEdit(uri: string, change: TextChange): void {
    const d = this.docs.get(uri);
    if (!d) { this.setDocument(uri, change.text); return; }
    const text = d.text.slice(0, change.rangeOffset) + change.text + d.text.slice(change.rangeOffset + change.rangeLength);
    const lines = lineStarts(text);
    d.tokens = relex(d.tokens, text, change, this.spec, lines);
    d.text = text;
    d.lines = lines;
    d.split = null;
    d.diags = null;
  }

  closeDocument(uri: string): void { this.docs.delete(uri); }

  private doc(uri: string): Doc {
    let d = this.docs.get(uri);
    if (!d) {
      d = { uri, text: '', tokens: tokenize('', this.spec), lines: [0], split: null, models: new Map(), diags: null };
      this.docs.set(uri, d);
    }
    return d;
  }

  getText(uri: string): string { return this.doc(uri).text; }
  tokens(uri: string): Token[] { return this.doc(uri).tokens; }

  private splitOf(d: Doc): SplitResult {
    if (!d.split) {
      d.split = splitStatements(d.tokens, d.text, this.spec, { blankLineSplitsStatements: this.opts.blankLineSplitsStatements });
      // keep only models of statements that still exist
      const keep = new Set(d.split.statements.map(modelKey));
      for (const k of [...d.models.keys()]) if (!keep.has(k)) d.models.delete(k);
    }
    return d.split;
  }

  private model(d: Doc, st: SplitStatement): StatementModel {
    const key = modelKey(st);
    let m = d.models.get(key);
    if (!m) {
      const sig: Token[] = [];
      for (let i = st.tokStart; i < st.tokEnd; i++) {
        const t = d.tokens[i];
        if (t.kind !== 'comment' && t.kind !== 'eof' && t.kind !== 'ws' && t.kind !== 'batchSep') sig.push(t);
      }
      m = buildModel(sig, this.spec, st.start, st.end);
      d.models.set(key, m);
    }
    return m;
  }

  statements(uri: string): StatementInfo[] {
    return this.splitOf(this.doc(uri)).statements;
  }

  statementAt(uri: string, offset: number): StatementInfo | null {
    const d = this.doc(uri);
    const sts = this.splitOf(d).statements;
    if (!sts.length) return null;
    let prev: SplitStatement | null = null;
    for (const st of sts) {
      if (st.start <= offset && offset <= st.end) return st;
      if (st.end < offset) prev = st;
      else {
        // offset is between prev and st
        if (prev && this.gapIsTrailing(d, prev.end, offset)) return prev;
        if (this.opts.runNextStatementOnBlank && /^\s*$/.test(d.text.slice(offset, st.start))) return st;
        return null;
      }
    }
    if (prev && this.gapIsTrailing(d, prev.end, offset)) return prev;
    return null;
  }

  /** Cursor on trailing whitespace of a statement: same line, or following lines without a blank line, no terminator in between. */
  private gapIsTrailing(d: Doc, end: number, offset: number): boolean {
    const gap = d.text.slice(end, offset);
    if (/\n[ \t\r]*\n/.test(gap)) return false;
    return /^[\s;]*$/.test(gap.replace(/--[^\n]*/g, ''));
  }

  // ---------------------------------------------------------------- execution

  private pos(d: Doc, offset: number): { line: number; col: number } {
    return positionAt(d.lines, offset);
  }

  batchesFor(uri: string, range?: [number, number]): SqlBatch[] {
    const d = this.doc(uri);
    if (range && range[1] > range[0]) {
      const [a, b] = range;
      const sub = d.text.slice(a, b);
      const toks = tokenize(sub, this.spec);
      const split = splitStatements(toks, sub, this.spec, { blankLineSplitsStatements: false });
      return this.batchesFromSplit(sub, split, (off) => this.pos(d, a + off));
    }
    return this.batchesFromSplit(d.text, this.splitOf(d), (off) => this.pos(d, off));
  }

  private batchesFromSplit(text: string, split: SplitResult, pos: (off: number) => { line: number; col: number }): SqlBatch[] {
    const out: SqlBatch[] = [];
    if (this.dialect === 'tsql') {
      for (const b of split.batches) {
        const raw = text.slice(b.start, b.end);
        const lead = raw.length - raw.trimStart().length;
        const sql = raw.trim();
        if (!sql) continue;
        const p = pos(b.start + lead);
        for (let i = 0; i < b.repeat; i++) out.push({ sql, line: p.line, col: p.col });
      }
      return out;
    }
    for (const st of split.statements) {
      if (st.skipOnRun || st.kind === 'empty') continue;
      const p = pos(st.start);
      out.push({ sql: st.execText ?? st.text, line: p.line, col: p.col });
    }
    return out;
  }

  classify(sql: string): StatementKind {
    const toks = tokenize(sql, this.spec);
    const split = splitStatements(toks, sql, this.spec, { blankLineSplitsStatements: false });
    if (!split.statements.length) return 'empty';
    const kinds = split.statements.map((s) => (s.kind === 'block' || s.kind === 'exec' || s.kind === 'sqlplus' || s.kind === 'psql' ? s.kind : classifyTokens(toks.slice(s.tokStart, s.tokEnd), this.spec)));
    return kinds.find(isDestructive) ?? kinds[0];
  }

  // ---------------------------------------------------------------- language features

  /** Statement used for language features at `offset` (a fresh empty statement after a terminator). */
  private featureStatement(d: Doc, offset: number): SplitStatement | null {
    const sts = this.splitOf(d).statements;
    let prev: SplitStatement | null = null;
    for (const st of sts) {
      if (st.start <= offset && offset <= st.end) return st;
      if (st.end < offset) prev = st; else break;
    }
    if (!prev) return null;
    const gap = d.text.slice(prev.end, offset);
    if (/[;]/.test(gap.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))) return null;
    if (this.opts.blankLineSplitsStatements && /\n[ \t\r]*\n/.test(gap)) return null;
    // a GO / slash line between?
    for (const t of d.tokens) {
      if (t.start >= prev.end && t.end <= offset && t.kind === 'batchSep') return null;
      if (t.start > offset) break;
    }
    return prev;
  }

  private symbols(d: Doc, st: SplitStatement): DocSymbols {
    const tables = new Map<string, TempTableDef>();
    const variables = new Map<string, VarDef>();
    const sts = this.splitOf(d).statements;
    for (const other of sts) {
      if (other.start > st.start) break;
      // cheap filter: only statements that can create tables or declare variables
      if (!this.mayDefine(d, other)) continue;
      const m = this.model(d, other);
      for (const t of m.created) if (!tables.has(t.name.toUpperCase())) tables.set(t.name.toUpperCase(), t);
      if (this.dialect === 'tsql' && other.batchIndex === st.batchIndex && other !== st) {
        for (const v of m.declared) variables.set(v.name.toUpperCase(), v);
      }
    }
    return { tables, variables };
  }

  private mayDefine(d: Doc, st: SplitStatement): boolean {
    for (let i = st.tokStart; i < st.tokEnd; i++) {
      const u = d.tokens[i].upper;
      if (u === 'CREATE' || u === 'DECLARE' || u === 'INTO') return true;
    }
    return false;
  }

  private binderFor(d: Doc, st: SplitStatement | null): Binder {
    return new Binder(this.index, st ? this.symbols(d, st) : undefined);
  }

  private inCommentOrString(d: Doc, offset: number, afterNumber = false): boolean {
    const toks = d.tokens;
    let lo = 0, hi = toks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (toks[mid].end < offset) lo = mid + 1; else hi = mid;
    }
    for (let i = Math.max(0, lo - 1); i < Math.min(toks.length, lo + 2); i++) {
      const t = toks[i];
      if (t.kind !== 'comment' && t.kind !== 'string' && t.kind !== 'number') continue;
      if (t.start < offset && offset < t.end) return true;
      if (offset === t.end && t.start < offset) {
        if (t.kind === 'comment' && (t.text.startsWith('--') || t.unterminated)) return true;
        if (t.kind === 'string' && t.unterminated) return true;
        if (t.kind === 'number' && afterNumber) return true;
      }
    }
    return false;
  }

  modelAt(uri: string, offset: number): StatementModel | null {
    const d = this.doc(uri);
    const st = this.featureStatement(d, offset);
    return st ? this.model(d, st) : null;
  }

  complete(uri: string, offset: number, trigger?: string): CompletionResult {
    void trigger;
    const d = this.doc(uri);
    const empty: CompletionResult = { items: [], isIncomplete: false, replaceRange: [offset, offset] };
    if (this.inCommentOrString(d, offset, true)) return empty;
    const st = this.featureStatement(d, offset);
    const model = st ? this.model(d, st) : buildModel([], this.spec, offset, offset);
    const binder = this.binderFor(d, st);
    const ctx = detectContext(model, offset, this.spec, d.text);
    return runComplete(ctx, { spec: this.spec, index: this.index, binder, opts: this.opts, usage: this.usage, text: d.text, statementEnd: st?.end ?? offset, extraSources: this.extraSources });
  }

  resolveItem(item: CompletionItem): CompletionItem { return item; }

  recordAccepted(item: Pick<CompletionItem, 'usageKey'>): void {
    if (item.usageKey) this.usage.record(item.usageKey);
  }

  hover(uri: string, offset: number): HoverInfo | null {
    const d = this.doc(uri);
    const st = this.featureStatement(d, offset);
    if (!st) return null;
    const m = this.model(d, st);
    const sym = symbolAt(m, offset, this.binderFor(d, st), this.spec, this.index);
    return sym ? hoverFor(sym, this.spec, this.index) : null;
  }

  definition(uri: string, offset: number): DefinitionResult | null {
    const d = this.doc(uri);
    const st = this.featureStatement(d, offset);
    if (!st) return null;
    const m = this.model(d, st);
    const sym = symbolAt(m, offset, this.binderFor(d, st), this.spec, this.index);
    return sym ? definitionFor(sym, this.index) : null;
  }

  signatureHelp(uri: string, offset: number): SignatureHelpInfo | null {
    const d = this.doc(uri);
    if (this.inCommentOrString(d, offset)) return null;
    const st = this.featureStatement(d, offset);
    if (!st) return null;
    const m = this.model(d, st);
    const ctx = detectContext(m, offset, this.spec, d.text);
    let call = ctx.inFunctionCall;
    if (!call) {
      const k = m.tokens.findIndex((t) => t.start >= offset);
      call = findCall(m.tokens, (k < 0 ? m.tokens.length : k) - 1, offset, this.spec);
    }
    if (!call) return null;
    return runSignature(call, this.spec, this.index);
  }

  softDiagnostics(uri: string): Diagnostic[] {
    const d = this.doc(uri);
    if (d.diags) return d.diags;
    const split = this.splitOf(d);
    const raw: RawDiagnostic[] = lexicalDiagnostics(d.tokens, split.statements);
    for (const st of split.statements) {
      const m = this.model(d, st);
      raw.push(...statementDiagnostics(st, m, this.binderFor(d, st), this.index, this.spec));
    }
    d.diags = raw.map((r) => {
      const a = this.pos(d, r.start), b = this.pos(d, Math.max(r.end, r.start));
      return { ...r, line: a.line, col: a.col, endLine: b.line, endCol: b.col };
    });
    return d.diags;
  }
}

export function createIntel(dialect: Dialect, opts?: Partial<IntelOptions>): Intel {
  return new IntelImpl(dialect, opts);
}
