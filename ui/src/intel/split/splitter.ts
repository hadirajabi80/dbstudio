// Statement and batch splitting (PLAN 4.4).
import type { StatementInfo, Token } from '../types';
import type { DialectSpec } from '../dialect/spec';
import { wordSet } from '../dialect/spec';
import { classifyTokens } from './classify';

export interface SplitStatement extends StatementInfo {
  /** Token index range in the document token array: [tokStart, tokEnd). */
  tokStart: number;
  tokEnd: number;
}

export interface BatchRange {
  index: number;
  /** Absolute offsets of the batch content (first to last token, comments included). */
  start: number;
  end: number;
  /** `GO 5` → 5. */
  repeat: number;
  /** Token index range [tokStart, tokEnd). */
  tokStart: number;
  tokEnd: number;
}

export interface SplitOptions { blankLineSplitsStatements: boolean }

export interface SplitResult { statements: SplitStatement[]; batches: BatchRange[] }

const TSQL_INCOMPLETE = wordSet(`
  SELECT FROM WHERE AND OR NOT ON JOIN INNER LEFT RIGHT FULL OUTER CROSS APPLY UNION ALL EXCEPT INTERSECT AS BY SET
  INTO VALUES THEN ELSE WHEN CASE IN EXISTS LIKE BETWEEN IS DISTINCT TOP GROUP ORDER HAVING INSERT UPDATE DELETE MERGE
  USING GRANT REVOKE DENY FOR WITH EXEC EXECUTE TABLE DECLARE OUTPUT OVER PARTITION`);
const TSQL_NOT_BLOCK_BEGIN = wordSet('TRAN TRANSACTION DISTRIBUTED DIALOG CONVERSATION');
const TSQL_DML = wordSet('SELECT INSERT UPDATE DELETE MERGE');
const TSQL_BODY_OBJECTS = wordSet('PROC PROCEDURE FUNCTION TRIGGER VIEW');

const ORA_BLOCK_OBJECTS = wordSet('PROCEDURE FUNCTION PACKAGE TYPE TRIGGER LIBRARY JAVA');
const ORA_CREATE_MODIFIERS = wordSet('OR REPLACE EDITIONABLE NONEDITIONABLE EDITIONING FORCE NOFORCE AND RESOLVE COMPILE NOCOMPILE SOURCE');
const SQLPLUS = wordSet(`
  SHOW SPOOL PROMPT DEFINE UNDEFINE COLUMN COL BREAK COMPUTE TTITLE BTITLE WHENEVER CONNECT CONN DISCONNECT EXIT QUIT
  REM REMARK START HOST PAUSE ACCEPT VARIABLE VAR PRINT DESC DESCRIBE CLEAR STORE SAVE GET EDIT RUN LIST APPEND
  CHANGE DEL INPUT PASSWORD RECOVER STARTUP SHUTDOWN ARCHIVE ATTRIBUTE COPY TIMING SQLPLUS XQUERY`);
const SQL_SET_TARGETS = wordSet('TRANSACTION ROLE CONSTRAINT CONSTRAINTS');

function isSig(t: Token): boolean {
  return t.kind !== 'comment' && t.kind !== 'eof' && t.kind !== 'ws';
}
function isWordTok(t: Token | undefined): boolean {
  return !!t && (t.kind === 'keyword' || t.kind === 'ident');
}

function hasBlankLine(text: string, from: number, to: number): boolean {
  let nl = 0;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) { nl++; if (nl >= 2) return true; }
    else if (c !== 32 && c !== 9 && c !== 13) nl = 0;
  }
  return false;
}

/** Splitter over the document token array; `text` is the document. */
export function splitStatements(tokens: Token[], text: string, spec: DialectSpec, opts: SplitOptions): SplitResult {
  const sig: number[] = [];
  for (let i = 0; i < tokens.length; i++) if (isSig(tokens[i])) sig.push(i);
  const b = new Builder(tokens, text, spec);
  switch (spec.id) {
    case 'tsql': splitTsql(b, sig, opts); break;
    case 'plsql': splitOracle(b, sig, opts); break;
    case 'sqlite': splitSqlite(b, sig, opts); break;
  }
  return { statements: b.statements, batches: b.batches };
}

class Builder {
  statements: SplitStatement[] = [];
  batches: BatchRange[] = [];
  private batchStartTok = 0;
  readonly tokens: Token[];
  readonly text: string;
  readonly spec: DialectSpec;
  constructor(tokens: Token[], text: string, spec: DialectSpec) {
    this.tokens = tokens;
    this.text = text;
    this.spec = spec;
  }

  /** Add a statement spanning tokens [first, last] (indices in `tokens`). */
  add(first: number, last: number, extra?: Partial<SplitStatement>): SplitStatement | null {
    if (last < first) return null;
    const a = this.tokens[first], z = this.tokens[last];
    const lastLine = z.line + countNl(z.text);
    const lastCol = z.text.lastIndexOf('\n') >= 0 ? z.text.length - z.text.lastIndexOf('\n') : z.col + z.text.length;
    const stmtTokens = this.tokens.slice(first, last + 1);
    const st: SplitStatement = {
      index: this.statements.length,
      start: a.start,
      end: z.end,
      text: this.text.slice(a.start, z.end),
      line: a.line,
      col: a.col,
      endLine: lastLine,
      endCol: lastCol,
      kind: classifyTokens(stmtTokens, this.spec),
      isPlsqlBlock: false,
      batchIndex: this.spec.id === 'tsql' ? this.batches.length : this.statements.length,
      tokStart: first,
      tokEnd: last + 1,
      ...extra,
    };
    this.statements.push(st);
    return st;
  }

  /** T-SQL: close the GO batch ending before token `sepIdx` (exclusive). */
  closeBatch(endTok: number, repeat: number): void {
    let first = this.batchStartTok;
    let last = endTok - 1;
    while (first <= last && this.tokens[first].kind === 'eof') first++;
    while (last >= first && this.tokens[last].kind === 'eof') last--;
    if (last >= first && this.tokens.slice(first, last + 1).some(isSig)) {
      this.batches.push({
        index: this.batches.length, start: this.tokens[first].start, end: this.tokens[last].end, repeat,
        tokStart: first, tokEnd: last + 1,
      });
    }
    this.batchStartTok = endTok + 1;
  }
}

function countNl(s: string): number {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

// ---------------------------------------------------------------- T-SQL

interface TsqlState {
  first: number;            // token index of the first token
  last: number;             // token index of the last significant token so far
  firstUpper: string;
  stack: ('begin' | 'case')[];
  parens: number;
  pending: number;          // IF/WHILE/ELSE bodies still expected
  bodyToEnd: boolean;       // CREATE PROC/FUNCTION/TRIGGER/VIEW: runs to the end of the batch
  seenMain: boolean;        // WITH ... <dml> seen
  insertHasSource: boolean;
  seenSet: boolean;
  sigCount: number;
}

function splitTsql(b: Builder, sig: number[], opts: SplitOptions): void {
  const toks = b.tokens;
  const spec = b.spec;
  let cur: TsqlState | null = null;
  let prevSig = -1;          // token index of the previous significant token (any statement)

  const nextSig = (k: number): Token | undefined => (k + 1 < sig.length ? toks[sig[k + 1]] : undefined);

  const close = () => {
    if (cur) b.add(cur.first, cur.last);
    cur = null;
  };
  const open = (ti: number): TsqlState => ({
    first: ti, last: ti, firstUpper: toks[ti].upper, stack: [], parens: 0, pending: 0, bodyToEnd: false,
    seenMain: false, insertHasSource: false, seenSet: false, sigCount: 0,
  });

  for (let k = 0; k < sig.length; k++) {
    const ti = sig[k];
    const t = toks[ti];
    if (t.kind === 'batchSep') {
      close();
      const m = /\d+/.exec(t.text);
      b.closeBatch(ti, m ? Math.max(1, parseInt(m[0], 10)) : 1);
      prevSig = ti;
      continue;
    }
    if (!cur) {
      if (t.text === ';') { prevSig = ti; continue; }
      cur = open(ti);
    } else if (cur.parens === 0 && cur.stack.length === 0 && !cur.bodyToEnd) {
      const prev = toks[prevSig];
      const blank = opts.blankLineSplitsStatements && cur.pending === 0 && hasBlankLine(b.text, prev.end, t.start);
      if (blank || canSplitTsql(cur, t, prev, nextSig(k), spec)) {
        close();
        cur = open(ti);
      }
    }
    const c: TsqlState = cur;
    // --- update state with token t
    c.sigCount++;
    if (t.text === '(' && t.kind === 'punct') c.parens++;
    else if (t.text === ')' && t.kind === 'punct') c.parens = Math.max(0, c.parens - 1);
    else if (c.parens === 0 && isWordTok(t)) {
      const u = t.upper;
      if (c.sigCount === 1 || (c.sigCount <= 4 && (c.firstUpper === 'CREATE' || c.firstUpper === 'ALTER'))) {
        if ((c.firstUpper === 'CREATE' || c.firstUpper === 'ALTER') && TSQL_BODY_OBJECTS.has(u)) c.bodyToEnd = true;
      }
      if (u === 'CASE') c.stack.push('case');
      else if (u === 'BEGIN') {
        const nx = nextSig(k);
        if (!(nx && TSQL_NOT_BLOCK_BEGIN.has(nx.upper))) {
          c.stack.push('begin');
          if (c.pending > 0 && c.stack.length === 1) c.pending--;
        }
      } else if (u === 'END') {
        c.stack.pop();
      } else if (c.stack.length === 0) {
        if (u === 'IF' || u === 'WHILE') {
          if (c.pending === 0) c.pending = 1;
        } else if (u === 'ELSE') c.pending++;
        else if (c.pending > 0 && spec.statementStarts.has(u) && ti !== c.first) c.pending--;
        if (c.firstUpper === 'WITH' && TSQL_DML.has(u) && ti !== c.first) c.seenMain = true;
        if (c.firstUpper === 'INSERT' && (u === 'SELECT' || u === 'VALUES' || u === 'EXEC' || u === 'EXECUTE' || u === 'DEFAULT' || u === 'WITH')) c.insertHasSource = true;
        if (c.firstUpper === 'UPDATE' && u === 'SET') c.seenSet = true;
      }
    }
    if (t.text === ';' && t.kind === 'punct') {
      if (c.parens === 0 && c.stack.length === 0 && !c.bodyToEnd) {
        const nx = nextSig(k);
        if (!(nx && nx.upper === 'ELSE' && nx.kind === 'keyword')) {
          close();
          prevSig = ti;
          continue;
        }
      }
    }
    c.last = ti;
    prevSig = ti;
  }
  close();
  b.closeBatch(toks.length - 1, 1);
}

function canSplitTsql(cur: TsqlState, t: Token, prev: Token, next: Token | undefined, spec: DialectSpec): boolean {
  if (!isWordTok(t) || !spec.statementStarts.has(t.upper)) return false;
  if (t.line === prev.line + countNl(prev.text) && prev.kind !== 'batchSep') return false; // not first on its line
  if (prev.kind === 'op') return false;
  if (prev.kind === 'punct' && (prev.text === ',' || prev.text === '(' || prev.text === '.')) return false;
  if (isWordTok(prev) && TSQL_INCOMPLETE.has(prev.upper)) return false;
  if (cur.pending > 0) return false;
  const u = t.upper;
  if (cur.firstUpper === 'INSERT' && !cur.insertHasSource && (u === 'SELECT' || u === 'WITH' || u === 'EXEC' || u === 'EXECUTE' || u === 'VALUES')) return false;
  if (cur.firstUpper === 'WITH' && !cur.seenMain && TSQL_DML.has(u)) return false;
  if (cur.firstUpper === 'UPDATE' && !cur.seenSet && u === 'SET') return false;
  if (u === 'WITH' && !(next && (next.kind === 'ident' || next.kind === 'quotedIdent'))) return false;
  return true;
}

// ---------------------------------------------------------------- Oracle

type OraMode = 'sql' | 'block' | 'sqlplus' | 'exec';

function oracleMode(toks: Token[], sig: number[], k: number): { mode: OraMode; pkg: boolean; typeSpec: boolean } {
  const t = toks[sig[k]];
  const u = t.upper;
  if (u === 'DECLARE' || u === 'BEGIN') return { mode: 'block', pkg: false, typeSpec: false };
  if (u === 'EXEC' || u === 'EXECUTE') return { mode: 'exec', pkg: false, typeSpec: false };
  if (t.kind === 'op' && t.text === '@') return { mode: 'sqlplus', pkg: false, typeSpec: false };
  if ((t.kind === 'ident' || t.kind === 'keyword') && SQLPLUS.has(u)) return { mode: 'sqlplus', pkg: false, typeSpec: false };
  if (u === 'SET') {
    const nx = sig[k + 1] !== undefined ? toks[sig[k + 1]] : undefined;
    if (!nx || !SQL_SET_TARGETS.has(nx.upper)) return { mode: 'sqlplus', pkg: false, typeSpec: false };
  }
  if (u === 'CREATE') {
    let j = k + 1;
    while (j < sig.length && ORA_CREATE_MODIFIERS.has(toks[sig[j]].upper)) j++;
    const obj = j < sig.length ? toks[sig[j]].upper : '';
    if (ORA_BLOCK_OBJECTS.has(obj)) {
      const nx = j + 1 < sig.length ? toks[sig[j + 1]].upper : '';
      const isBody = nx === 'BODY';
      if (obj === 'TYPE' && !isBody) return { mode: 'sql', pkg: false, typeSpec: true };
      return { mode: 'block', pkg: obj === 'PACKAGE' || (obj === 'TYPE' && isBody), typeSpec: false };
    }
  }
  return { mode: 'sql', pkg: false, typeSpec: false };
}

function splitOracle(b: Builder, sig: number[], opts: SplitOptions): void {
  const toks = b.tokens;
  let k = 0;
  while (k < sig.length) {
    const ti = sig[k];
    const t = toks[ti];
    if (t.kind === 'batchSep' || (t.kind === 'punct' && t.text === ';')) { k++; continue; }
    const { mode, pkg } = oracleMode(toks, sig, k);
    const first = ti;
    if (mode === 'sqlplus' || mode === 'exec') {
      // runs to the end of the line (or a `;` for EXEC)
      let last = k;
      while (last + 1 < sig.length) {
        const nt = toks[sig[last + 1]];
        if (nt.line !== t.line || nt.kind === 'batchSep') break;
        if (mode === 'exec' && nt.text === ';' && nt.kind === 'punct') break;
        last++;
      }
      const lastTi = sig[last];
      const st = b.add(first, lastTi);
      if (st) {
        if (mode === 'exec') {
          const body = b.text.slice(toks[sig[Math.min(k + 1, last)]].start, toks[lastTi].end).trim();
          st.execText = k + 1 <= last ? `BEGIN ${body.replace(/;\s*$/, '')}; END;` : 'BEGIN NULL; END;';
          st.kind = 'exec';
        } else {
          st.skipOnRun = true;
          st.kind = 'sqlplus';
        }
      }
      k = last + 1;
      continue;
    }
    if (mode === 'sql') {
      let parens = 0;
      let last = k;
      let j = k;
      let endedAt = -1;
      for (; j < sig.length; j++) {
        const x = toks[sig[j]];
        if (x.kind === 'batchSep') { endedAt = j; break; }
        if (j > k && parens === 0 && opts.blankLineSplitsStatements && hasBlankLine(b.text, toks[sig[j - 1]].end, x.start)) { endedAt = j - 1; j--; break; }
        if (x.kind === 'punct') {
          if (x.text === '(') parens++;
          else if (x.text === ')') parens = Math.max(0, parens - 1);
          else if (x.text === ';' && parens === 0) { endedAt = j; break; }
        }
        last = j;
      }
      b.add(first, sig[last]);
      k = endedAt >= 0 ? endedAt + 1 : j;
      if (endedAt === -1) k = sig.length;
      continue;
    }
    // PL/SQL block
    let depth = 0;
    let pkgOpened = !pkg;
    let last = k;
    let j = k;
    let closedByEnd = false;
    let missingSlash = false;
    let terminated = false;
    for (; j < sig.length; j++) {
      const x = toks[sig[j]];
      if (x.kind === 'batchSep') { terminated = true; break; }
      const prevU = j > k ? toks[sig[j - 1]].upper : '';
      if (isWordTok(x)) {
        const u = x.upper;
        if (!pkgOpened && (u === 'AS' || u === 'IS') && depth === 0) { depth++; pkgOpened = true; }
        else if (u === 'BEGIN' || u === 'CASE') depth++;
        else if ((u === 'IF' || u === 'LOOP') && prevU !== 'END') depth++;
        else if (u === 'COMPOUND' && j + 1 < sig.length && toks[sig[j + 1]].upper === 'TRIGGER') depth++;
        else if (u === 'END') {
          depth = Math.max(0, depth - 1);
          if (depth === 0) closedByEnd = true;
        }
      }
      last = j;
      if (x.kind === 'punct' && x.text === ';' && depth === 0 && closedByEnd) {
        const nextTok = toks[sig[j] + 1];
        const nextSigTok = j + 1 < sig.length ? toks[sig[j + 1]] : undefined;
        if (nextSigTok && nextSigTok.kind === 'batchSep') continue;
        if (!nextSigTok || !nextTok || nextTok.kind === 'eof' || hasBlankLine(b.text, x.end, (nextTok ?? x).start)) {
          missingSlash = true;
          j++;
          break;
        }
      }
      if (x.kind === 'punct' && x.text === ';' && depth === 0) closedByEnd = false;
    }
    const st = b.add(first, sig[last], { isPlsqlBlock: true });
    if (st) {
      st.kind = 'block';
      if (missingSlash || !terminated) st.missingSlash = true;
    }
    k = terminated ? j + 1 : j;
  }
}

// ---------------------------------------------------------------- SQLite

function splitSqlite(b: Builder, sig: number[], opts: SplitOptions): void {
  const toks = b.tokens;
  let k = 0;
  while (k < sig.length) {
    const t = toks[sig[k]];
    if (t.kind === 'punct' && t.text === ';') { k++; continue; }
    // CREATE [TEMP|TEMPORARY] TRIGGER → BEGIN ... END
    let trigger = false;
    if (t.upper === 'CREATE') {
      const a = toks[sig[k + 1]]?.upper, c = toks[sig[k + 2]]?.upper;
      trigger = a === 'TRIGGER' || ((a === 'TEMP' || a === 'TEMPORARY') && c === 'TRIGGER');
    }
    let parens = 0, depth = 0, last = k, j = k, endedAt = -1;
    for (; j < sig.length; j++) {
      const x = toks[sig[j]];
      if (j > k && parens === 0 && depth === 0 && opts.blankLineSplitsStatements && hasBlankLine(b.text, toks[sig[j - 1]].end, x.start)) break;
      if (x.kind === 'punct') {
        if (x.text === '(') parens++;
        else if (x.text === ')') parens = Math.max(0, parens - 1);
        else if (x.text === ';' && parens === 0 && depth === 0) { endedAt = j; break; }
      } else if (trigger && isWordTok(x)) {
        if (x.upper === 'BEGIN' || x.upper === 'CASE') depth++;
        else if (x.upper === 'END') depth = Math.max(0, depth - 1);
      } else if (isWordTok(x) && x.upper === 'CASE') depth++;
      else if (isWordTok(x) && x.upper === 'END' && depth > 0) depth--;
      last = j;
    }
    b.add(sig[k], sig[last]);
    k = endedAt >= 0 ? endedAt + 1 : Math.max(j, last + 1);
  }
}
