// Error-tolerant structure parser (PLAN 4.6). Understands only what completion/diagnostics need and skips
// everything else token by token. Never throws on bad input; always makes progress.
import type { Token } from '../types';
import type { DialectSpec } from '../dialect/spec';
import { wordSet } from '../dialect/spec';
import type {
  ClauseKind, ColumnDef, CteDef, Marker, MarkerData, NamePart, Projection, Scope, ScopeKind, StatementModel,
  TableRef, TempTableDef, VarDef,
} from './statement-model';

const SELECT_CLAUSES = wordSet('FROM INTO WHERE GROUP ORDER HAVING UNION EXCEPT INTERSECT MINUS LIMIT OFFSET FETCH FOR OPTION WINDOW CONNECT START RETURNING BULK');
const WHERE_STOPS = wordSet('GROUP ORDER HAVING UNION EXCEPT INTERSECT MINUS LIMIT OFFSET FETCH FOR OPTION WINDOW CONNECT START RETURNING OUTPUT');
const AFTER_FROM_STOPS = wordSet('WHERE GROUP ORDER HAVING UNION EXCEPT INTERSECT MINUS LIMIT OFFSET FETCH FOR OPTION WINDOW CONNECT START RETURNING OUTPUT SET ON USING JOIN WHEN');
const ORACLE_ATTR_ROWTYPE = '%ROWTYPE';
const ORACLE_ATTR_TYPE = '%TYPE';
const CREATE_MODIFIERS = wordSet(`
  OR REPLACE ALTER TEMP TEMPORARY GLOBAL LOCAL UNIQUE CLUSTERED NONCLUSTERED BITMAP EDITIONABLE NONEDITIONABLE
  EDITIONING FORCE NOFORCE VIRTUAL PUBLIC PRIVATE SHARDED DUPLICATED IMMUTABLE BLOCKCHAIN COLUMNSTORE FULLTEXT SPATIAL XML
  PRIMARY SECURE`);
const TSQL_BLOCK_BEGIN_NOT = wordSet('TRAN TRANSACTION DISTRIBUTED DIALOG CONVERSATION');
const TABLE_CONSTRAINT_STARTS = wordSet('CONSTRAINT PRIMARY FOREIGN UNIQUE CHECK INDEX KEY PERIOD');

function isWord(t: Token | undefined): boolean {
  return !!t && (t.kind === 'ident' || t.kind === 'keyword');
}
function isNameTok(t: Token | undefined): boolean {
  return !!t && (t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'quotedIdent');
}

/** Unquote an identifier token's text. */
export function unquote(text: string): { text: string; quoted: boolean } {
  const c = text[0];
  if (c === '[') {
    const inner = text.endsWith(']') && text.length > 1 ? text.slice(1, -1) : text.slice(1);
    return { text: inner.replace(/]]/g, ']'), quoted: true };
  }
  if (c === '"' || c === '`') {
    const inner = text.length > 1 && text.endsWith(c) ? text.slice(1, -1) : text.slice(1);
    return { text: inner.split(c + c).join(c), quoted: true };
  }
  return { text, quoted: false };
}

export function namePart(t: Token): NamePart {
  const u = unquote(t.text);
  return { text: u.text, quoted: u.quoted, range: [t.start, t.end] };
}

let scopeIds = 0;

class Parser {
  readonly t: Token[];
  readonly spec: DialectSpec;
  readonly n: number;
  i = 0;
  readonly m: StatementModel;
  readonly tsql: boolean;
  readonly ora: boolean;
  readonly lite: boolean;
  readonly pg: boolean;

  constructor(tokens: Token[], spec: DialectSpec, start: number, end: number) {
    this.t = tokens;
    this.n = tokens.length;
    this.spec = spec;
    this.tsql = spec.id === 'tsql';
    this.ora = spec.id === 'plsql';
    this.lite = spec.id === 'sqlite';
    this.pg = spec.id === 'pgsql';
    const root = this.mkScope('other', null, null, start);
    this.m = { root, scopes: [root], tokens, chains: [], created: [], declared: [], start, end };
  }

  // ------------------------------------------------------------ helpers
  peek(k = 0): Token | undefined { return this.t[this.i + k]; }
  u(k = 0): string {
    const t = this.t[this.i + k];
    return t && (t.kind === 'ident' || t.kind === 'keyword') ? t.upper : '';
  }
  at(word: string, k = 0): boolean { return this.u(k) === word; }
  atP(text: string, k = 0): boolean {
    const t = this.t[this.i + k];
    return !!t && t.kind === 'punct' && t.text === text;
  }
  atOp(text: string, k = 0): boolean {
    const t = this.t[this.i + k];
    return !!t && t.kind === 'op' && t.text === text;
  }
  eof(): boolean { return this.i >= this.n; }
  prevEnd(): number { return this.i > 0 ? this.t[this.i - 1].end : this.m.start; }
  curStart(): number { return this.i < this.n ? this.t[this.i].start : Infinity; }

  mkScope(kind: ScopeKind, parent: Scope | null, outer: Scope | null, start: number): Scope {
    const s: Scope = {
      id: ++scopeIds, kind, range: [start, Infinity], parent, children: [], outer, sources: [], ctes: [],
      projections: [], joins: [], localVars: new Map(), markers: [], hasFrom: false, hasWhere: false, start,
    };
    if (parent) parent.children.push(s);
    if (this.m) this.m.scopes.push(s);
    return s;
  }
  mark(s: Scope, clause: ClauseKind, pos: number, data?: MarkerData): void {
    const mk: Marker = { pos, clause };
    if (data) mk.data = data;
    s.markers.push(mk);
  }
  /** Close a scope at the current token (its range ends where the terminating token starts). */
  endScope(s: Scope): void {
    s.range[1] = this.curStart();
  }
  skipParens(): void {
    // assumes at '('
    let depth = 0;
    while (!this.eof()) {
      const t = this.t[this.i];
      if (t.kind === 'punct' && t.text === '(') depth++;
      else if (t.kind === 'punct' && t.text === ')') {
        depth--;
        if (depth <= 0) { this.i++; return; }
      }
      this.i++;
    }
  }
  varKey(name: string): string {
    const n = name.startsWith(':') ? name.slice(1) : name;
    return n.toUpperCase();
  }

  /** Start of a T-SQL statement keyword that ends the previous statement inside a block. */
  isTsqlStmtStart(t: Token, k: number): boolean {
    if (!this.tsql || t.kind !== 'keyword' || !this.spec.statementStarts.has(t.upper)) return false;
    const nx = this.t[k + 1];
    if (nx && nx.kind === 'punct' && nx.text === '(' && t.upper !== 'IF' && t.upper !== 'WHILE') return false;
    if (t.upper === 'WITH') {
      // WITH (hints) / WITH TIES / WITH CHECK OPTION are not statement starts
      return !!nx && (nx.kind === 'ident' || nx.kind === 'quotedIdent') && !!this.t[k + 2] &&
        (this.t[k + 2].upper === 'AS' || (this.t[k + 2].kind === 'punct' && this.t[k + 2].text === '('));
    }
    return true;
  }

  /** Clause word at token index k (with lookahead), or null. */
  clauseAt(k: number): string | null {
    const t = this.t[k];
    if (!isWord(t)) return null;
    const u = t.upper;
    const nu = this.t[k + 1] && isWord(this.t[k + 1]) ? this.t[k + 1].upper : '';
    switch (u) {
      case 'FROM': case 'WHERE': case 'HAVING': case 'UNION': case 'EXCEPT': case 'INTERSECT': case 'INTO': case 'WHEN':
        return u;
      case 'MINUS': return this.ora ? u : null;
      case 'GROUP': case 'ORDER': return nu === 'BY' ? u : null;
      case 'CONNECT': return nu === 'BY' ? u : null;
      case 'START': return nu === 'WITH' ? u : null;
      case 'FOR': return nu === 'UPDATE' || nu === 'JSON' || nu === 'XML' || nu === 'BROWSE' || nu === 'READ' || nu === 'SYSTEM_TIME' || (this.pg && (nu === 'SHARE' || nu === 'NO' || nu === 'KEY')) ? u : null;
      case 'OPTION': return this.tsql && this.t[k + 1]?.text === '(' ? u : null;
      case 'LIMIT': case 'WINDOW': return this.lite || t.kind === 'keyword' ? u : null;
      case 'OFFSET': {
        const nx = this.t[k + 1];
        return nx && (nx.kind === 'number' || nx.kind === 'param' || nx.text === '(' || isWord(nx)) && !(nx.kind === 'punct' && nx.text !== '(') ? u : null;
      }
      case 'FETCH': return nu === 'FIRST' || nu === 'NEXT' ? u : null;
      case 'RETURNING': return u;
      case 'OUTPUT': return this.tsql ? u : null;
      case 'BULK': return this.ora && nu === 'COLLECT' ? u : null;
      case 'SET': case 'ON': case 'USING': return u;
      default: return null;
    }
  }

  /** Join phrase at the current position: number of tokens (incl. JOIN/APPLY) and whether it is APPLY. */
  joinAt(): { len: number; apply: boolean } | null {
    let k = 0;
    const w = (j: number) => this.u(j);
    if (w(k) === 'NATURAL') k++;
    const first = w(k);
    if (first === 'CROSS' || first === 'OUTER') {
      if (w(k + 1) === 'APPLY') return { len: k + 2, apply: true };
      if (first === 'CROSS' && w(k + 1) === 'JOIN') return { len: k + 2, apply: false };
      return null;
    }
    if (first === 'INNER' || first === 'LEFT' || first === 'RIGHT' || first === 'FULL') {
      k++;
      if (w(k) === 'OUTER') k++;
      if (w(k) === 'HASH' || w(k) === 'LOOP' || w(k) === 'MERGE' || w(k) === 'REMOTE') k++;
      return w(k) === 'JOIN' ? { len: k + 1, apply: false } : null;
    }
    if (first === 'JOIN') return { len: k + 1, apply: false };
    if (k > 0 && first === 'JOIN') return { len: k + 1, apply: false };
    return null;
  }

  isAliasCandidate(t: Token | undefined): boolean {
    if (!t) return false;
    if (t.kind === 'quotedIdent') return true;
    if (t.kind !== 'ident') return false;
    return !this.spec.notAlias.has(t.upper);
  }

  // ------------------------------------------------------------ expressions

  /**
   * Scan an expression until a stop at depth 0. Records identifier chains and creates child scopes for
   * subqueries in parentheses (correlated: they see the outer sources).
   */
  scanExpr(s: Scope, stop: (k: number) => boolean): void {
    let depth = 0;
    let caseDepth = 0;
    while (this.i < this.n) {
      const k = this.i;
      const tok = this.t[k];
      if (depth === 0 && caseDepth === 0) {
        if (tok.kind === 'punct' && (tok.text === ';' || tok.text === ')')) return;
        if (stop(k)) return;
        if (isWord(tok)) {
          const u = tok.upper;
          if (u === 'ELSE' || u === 'END' || u === 'ELSIF' || u === 'EXCEPTION' || u === 'THEN') return;
          if (u === 'LOOP' && this.ora) return;
          if (this.isTsqlStmtStart(tok, k)) return;
        }
      }
      if (tok.kind === 'punct' && tok.text === '(') {
        const nx = this.t[k + 1];
        const pv = this.t[k - 1];
        if (this.pg && nx && pv && isWord(pv) && ((pv.upper === 'FILTER' && isWord(nx) && nx.upper === 'WHERE') || (pv.upper === 'GROUP' && this.t[k - 2]?.upper === 'WITHIN' && isWord(nx) && nx.upper === 'ORDER' && this.t[k + 2]?.upper === 'BY'))) {
          // aggregate FILTER (WHERE …) / WITHIN GROUP (ORDER BY …): a condition / sort list over the same sources
          const resume = [...s.markers].reverse().find((m) => m.pos <= tok.start);
          const isFilter = nx.upper === 'WHERE';
          this.i += isFilter ? 2 : 3;
          this.mark(s, isFilter ? 'where' : 'orderBy', this.t[this.i - 1].end);
          this.scanExpr(s, () => false);
          if (this.atP(')')) {
            const close = this.t[this.i];
            this.i++;
            if (resume) this.mark(s, resume.clause, close.end, resume.data);
          }
          continue;
        }
        if (nx && isWord(nx) && (nx.upper === 'SELECT' || (nx.upper === 'WITH' && isNameTok(this.t[k + 2])))) {
          const prev = this.t[k - 1];
          const kind: ScopeKind = prev && isWord(prev) && prev.upper === 'EXISTS' ? 'exists' : 'subquery';
          this.i++;
          const sub = this.parseQuery(s, kind, s);
          if (this.atP(')')) this.i++;
          void sub;
          continue;
        }
        depth++;
        this.i++;
        continue;
      }
      if (tok.kind === 'punct' && tok.text === ')') { depth--; this.i++; continue; }
      if (isWord(tok) && tok.upper === 'CASE') { caseDepth++; this.i++; continue; }
      if (isWord(tok) && tok.upper === 'END' && caseDepth > 0) {
        caseDepth--;
        this.i++;
        if (this.ora && this.at('CASE')) this.i++;
        continue;
      }
      if (isNameTok(tok) || (tok.kind === 'param' && this.ora)) {
        this.chain(s);
        continue;
      }
      this.i++;
    }
  }

  /** Record an identifier chain starting at the current token; advances past it. */
  chain(s: Scope): void {
    const first = this.t[this.i];
    const parts: NamePart[] = [namePart(first)];
    let j = this.i + 1;
    while (j + 1 < this.n && this.t[j].kind === 'punct' && this.t[j].text === '.' && isNameTok(this.t[j + 1]) && this.t[j + 1].start === this.t[j].end &&
      !(this.t[j + 1].kind === 'keyword' && this.clauseAt(j + 1) !== null)) {
      parts.push(namePart(this.t[j + 1]));
      j += 2;
    }
    const isCall = !!this.t[j] && this.t[j].kind === 'punct' && this.t[j].text === '(';
    this.m.chains.push({ parts, range: [first.start, this.t[j - 1].end], scope: s, isCall });
    this.i = j;
  }

  /** Dotted name: `a.b.c`, T-SQL `db..obj`. Accepts keywords after a dot. */
  parseName(allowParamFirst = false): NamePart[] {
    const parts: NamePart[] = [];
    const first = this.peek();
    if (!first) return parts;
    if (isNameTok(first) || (allowParamFirst && first.kind === 'param')) {
      parts.push(namePart(first));
      this.i++;
    } else return parts;
    while (this.atP('.')) {
      if (this.tsql && this.atP('.', 1)) {
        const dot = this.t[this.i];
        parts.push({ text: '', quoted: false, range: [dot.end, dot.end] });
        this.i++;
        continue;
      }
      const nx = this.peek(1);
      if (!isNameTok(nx) || nx!.start !== this.t[this.i].end) break;
      parts.push(namePart(nx!));
      this.i += 2;
    }
    return parts;
  }

  // ------------------------------------------------------------ statements

  parseStatementList(c: Scope, terminators: Set<string>): void {
    while (!this.eof()) {
      const t = this.t[this.i];
      if (t.kind === 'punct' && t.text === ';') { this.i++; continue; }
      if (isWord(t) && terminators.has(t.upper)) return;
      if (t.kind === 'punct' && t.text === ')') return;
      const before = this.i;
      this.parseStatement(c);
      if (this.i === before) this.i++;
    }
  }

  parseStatement(c: Scope): void {
    const t = this.peek();
    if (!t) return;
    const u = isWord(t) ? t.upper : '';
    if (t.kind === 'punct' && t.text === '(' && (this.at('SELECT', 1) || this.at('WITH', 1))) {
      this.parseQuery(c, 'select', null);
      return;
    }
    switch (u) {
      case 'WITH': case 'SELECT': case 'VALUES': {
        if (u === 'VALUES' && !this.lite && !this.pg) break;
        this.parseQuery(c, 'select', null);
        return;
      }
      case 'INSERT': this.parseInsert(this.mkScope('insert', c, null, t.start)); return;
      case 'REPLACE': if (this.lite) { this.parseInsert(this.mkScope('insert', c, null, t.start)); return; } break;
      case 'UPDATE': this.parseUpdate(this.mkScope('update', c, null, t.start)); return;
      case 'DELETE': this.parseDelete(this.mkScope('delete', c, null, t.start)); return;
      case 'MERGE': this.parseMerge(this.mkScope('merge', c, null, t.start)); return;
      case 'CREATE': this.parseCreate(c); return;
      case 'ALTER': this.parseAlter(c); return;
      case 'DROP': case 'TRUNCATE':
        if (this.pg && u === 'TRUNCATE') break;
        this.parseDropLike(c);
        return;
      case 'EXEC': case 'EXECUTE': case 'CALL':
        if (this.ora && u === 'EXECUTE' && this.at('IMMEDIATE', 1)) break;
        this.parseExec(c);
        return;
      case 'DECLARE':
        if (this.ora) { this.parseBlock(c); return; }
        if (this.tsql) { this.parseTsqlDeclare(c); return; }
        break;
      case 'BEGIN':
        if (this.ora) { this.parseBlock(c); return; }
        if (this.tsql) {
          if (TSQL_BLOCK_BEGIN_NOT.has(this.u(1))) { this.skipSimple(c); return; }
          this.i++;
          if (this.at('TRY') || this.at('CATCH') || this.at('ATOMIC')) this.i++;
          if (this.at('WITH') && this.atP('(', 1)) { this.i++; this.skipParens(); }
          this.mark(c, 'unknown', this.prevEnd(), { statementStart: true });
          this.parseStatementList(c, wordSet('END'));
          if (this.at('END')) {
            this.i++;
            if (this.at('TRY') || this.at('CATCH')) this.i++;
          }
          return;
        }
        break;
      case 'IF': case 'WHILE':
        if (this.tsql) { this.parseTsqlIf(c); return; }
        if (this.ora && u === 'IF') { this.parsePlsqlIf(c); return; }
        if (this.ora && u === 'WHILE') { this.parsePlsqlLoop(c); return; }
        break;
      case 'LOOP': if (this.ora) { this.parsePlsqlLoop(c); return; } break;
      case 'FOR': if (this.ora) { this.parsePlsqlFor(c); return; } break;
      case 'FORALL':
        if (this.ora) {
          while (!this.eof() && !['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(this.u()) && !this.atP(';')) this.i++;
          if (!this.eof() && !this.atP(';')) this.parseStatement(c);
          return;
        }
        break;
      case 'CASE': if (this.ora) { this.parsePlsqlCase(c); return; } break;
      case 'OPEN':
        if (this.ora && this.at('FOR', 2)) {
          this.i += 3;
          this.parseQuery(c, 'select', null);
          return;
        }
        break;
      case 'SET':
        if (this.tsql) { this.parseTsqlSet(c); return; }
        break;
      case 'USE':
        if (this.tsql) {
          // USE <database>: the name position completes database names
          this.i++;
          this.mark(c, 'use', t.end);
          this.parseName();
          return;
        }
        break;
    }
    if (this.pg && this.parsePgStatement(c, u)) return;
    this.parseExprStatement(c);
  }

  /** Generic statement: an expression context up to the end (`;` / statement start). */
  parseExprStatement(c: Scope): void {
    const t = this.t[this.i];
    // PL/SQL labels <<name>>
    if (t.kind === 'op' && t.text === '<<') {
      while (!this.eof() && !this.atOp('>>')) this.i++;
      if (!this.eof()) this.i++;
      return;
    }
    this.mark(c, 'expr', t.start, { statementStart: true });
    if (t.kind === 'keyword' || (t.kind === 'ident' && this.spec.statementStarts.has(t.upper))) {
      // keyword-led statement (PRINT, RETURN, RAISE, ...): the rest is an expression
      this.i++;
      this.mark(c, 'expr', t.end);
    }
    this.scanExpr(c, () => false);
    if (this.ora && this.atP(';')) this.i++;
  }

  skipSimple(_c: Scope): void {
    this.i++;
    while (!this.eof()) {
      const t = this.t[this.i];
      if (t.kind === 'punct' && t.text === ';') return;
      if (this.isTsqlStmtStart(t, this.i)) return;
      this.i++;
    }
  }

  // ------------------------------------------------------------ queries

  /** Parse a query (WITH / SELECT / set operations) into a new scope. Stops before ')' or ';'. */
  parseQuery(parent: Scope, kind: ScopeKind, outer: Scope | null): Scope {
    const st = this.peek();
    const s = this.mkScope(kind, parent, outer, st ? st.start : this.prevEnd());
    if (this.pg && kind === 'cte') {
      // data-modifying CTE: WITH moved AS (DELETE … RETURNING *) — its output columns are the RETURNING list
      const u0 = this.u();
      if (u0 === 'INSERT') { this.parseInsert(s); return s; }
      if (u0 === 'UPDATE') { this.parseUpdate(s); return s; }
      if (u0 === 'DELETE') { this.parseDelete(s); return s; }
      if (u0 === 'MERGE') { this.parseMerge(s); return s; }
    }
    if (this.at('WITH')) {
      this.parseWith(s);
      const u = this.u();
      if (u === 'INSERT' || u === 'UPDATE' || u === 'DELETE' || u === 'MERGE') {
        s.kind = u.toLowerCase() as ScopeKind;
        if (u === 'INSERT') this.parseInsert(s);
        else if (u === 'UPDATE') this.parseUpdate(s);
        else if (u === 'DELETE') this.parseDelete(s);
        else this.parseMerge(s);
        return s;
      }
    }
    this.parseSelectBody(s);
    this.endScope(s);
    return s;
  }

  parseWith(owner: Scope): void {
    const w = this.t[this.i];
    this.i++;
    this.mark(owner, 'with', w.end);
    let recursive = false;
    if (this.at('RECURSIVE')) { recursive = true; this.i++; }
    while (!this.eof()) {
      const nt = this.peek();
      if (!isNameTok(nt) || (isWord(nt) && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(nt!.upper))) break;
      this.i++;
      const np = namePart(nt!);
      const cte: CteDef = { name: np.text, quoted: np.quoted, nameRange: np.range, columns: null, body: null, recursive };
      owner.ctes.push(cte);
      if (this.atP('(')) {
        const open = this.t[this.i];
        this.mark(owner, 'cteColumns', open.end);
        this.i++;
        const cols: string[] = [];
        while (!this.eof() && !this.atP(')')) {
          const ct = this.t[this.i];
          if (isNameTok(ct)) cols.push(namePart(ct).text);
          this.i++;
        }
        cte.columns = cols;
        if (this.atP(')')) { this.mark(owner, 'with', this.t[this.i].end); this.i++; }
      }
      if (this.at('AS')) { this.mark(owner, 'with', this.t[this.i].end); this.i++; }
      if (this.at('NOT')) this.i++;
      if (this.at('MATERIALIZED')) this.i++;
      if (this.atP('(')) {
        this.i++;
        cte.body = this.parseQuery(owner, 'cte', null);
        if (this.atP(')')) { this.mark(owner, 'with', this.t[this.i].end); this.i++; }
      }
      // Oracle SEARCH/CYCLE clauses: skip to ',' or the main query
      while (!this.eof() && (this.at('SEARCH') || this.at('CYCLE'))) {
        while (!this.eof() && !this.atP(',') && !this.at('SELECT')) this.i++;
      }
      if (this.atP(',')) {
        this.mark(owner, 'with', this.t[this.i].end);
        this.i++;
        continue;
      }
      break;
    }
  }

  parseSelectBody(s: Scope): void {
    if (this.atP('(') && (this.at('SELECT', 1) || this.at('WITH', 1))) {
      this.i++;
      this.parseQuery(s, 'subquery', null);
      if (this.atP(')')) this.i++;
    } else if (this.at('SELECT')) {
      const sel = this.t[this.i];
      this.mark(s, 'select', sel.end);
      this.i++;
      this.skipSelectModifiers();
      if (this.pg && this.at('ON') && this.atP('(', 1) && this.t[this.i - 1]?.upper === 'DISTINCT') {
        // DISTINCT ON (exprs): an expression list over the query's sources, not a projection
        this.i += 2;
        this.scanExpr(s, () => false);
        if (this.atP(')')) { this.mark(s, 'select', this.t[this.i].end); this.i++; }
      }
      this.parseSelectList(s);
    } else if (this.at('VALUES')) {
      this.parseValuesRows(s);
    }
    this.parseQueryClauses(s);
  }

  skipSelectModifiers(): void {
    for (;;) {
      const u = this.u();
      if (u === 'DISTINCT' || u === 'ALL' || u === 'DISTINCTROW' || (this.ora && u === 'UNIQUE')) { this.i++; continue; }
      if (u === 'TOP' && this.tsql) {
        this.i++;
        if (this.atP('(')) this.skipParens(); else if (!this.eof()) this.i++;
        if (this.at('PERCENT')) this.i++;
        if (this.at('WITH') && this.at('TIES', 1)) this.i += 2;
        continue;
      }
      return;
    }
  }

  parseSelectList(s: Scope): void {
    const stop = (k: number) => {
      const t = this.t[k];
      if (t.kind === 'punct' && t.text === ',') return true;
      const c = this.clauseAt(k);
      return !!c && SELECT_CLAUSES.has(c);
    };
    while (!this.eof()) {
      const a = this.i;
      this.scanExpr(s, stop);
      if (this.i > a) s.projections.push(this.projection(a, this.i));
      if (this.atP(',')) { this.i++; continue; }
      break;
    }
  }

  projection(a: number, b: number): Projection {
    const toks = this.t.slice(a, b);
    let end = toks.length;
    let alias: string | null = null;
    let aliasRange: [number, number] | null = null;
    let startIdx = 0;
    let assignment = false;
    const last = toks[end - 1];
    if (end >= 3 && isWord(toks[end - 2]) && toks[end - 2].upper === 'AS' && (isNameTok(last) || last.kind === 'string')) {
      alias = last.kind === 'string' ? last.text.slice(1, -1) : namePart(last).text;
      aliasRange = [last.start, last.end];
      end -= 2;
    } else if (end >= 2 && (last.kind === 'ident' || last.kind === 'quotedIdent')) {
      const prev = toks[end - 2];
      const prevOk = prev.kind === 'ident' || prev.kind === 'quotedIdent' || prev.kind === 'number' || prev.kind === 'string' ||
        prev.kind === 'param' || (prev.kind === 'punct' && prev.text === ')') || (isWord(prev) && (prev.upper === 'END' || prev.upper === 'NULL'));
      if (prevOk && !(prev.kind === 'punct' && prev.text === '.')) {
        alias = namePart(last).text;
        aliasRange = [last.start, last.end];
        end -= 1;
      }
    }
    if (this.tsql && toks.length >= 3 && toks[1].kind === 'op' && toks[1].text === '=') {
      if (toks[0].kind === 'param') assignment = true;
      else if (isNameTok(toks[0]) && !alias) {
        alias = namePart(toks[0]).text;
        aliasRange = [toks[0].start, toks[0].end];
        startIdx = 2;
      }
    }
    const rest = toks.slice(startIdx, end);
    let colRef: Projection['colRef'] = null;
    let star: Projection['star'] = null;
    if (rest.length >= 1 && rest.length % 2 === 1) {
      let chainOk = true;
      const parts: NamePart[] = [];
      for (let k = 0; k < rest.length; k++) {
        const t = rest[k];
        if (k % 2 === 1) { if (!(t.kind === 'punct' && t.text === '.')) { chainOk = false; break; } continue; }
        if (isNameTok(t) || (t.kind === 'op' && t.text === '*' && k === rest.length - 1)) parts.push(t.text === '*' ? { text: '*', quoted: false, range: [t.start, t.end] } : namePart(t));
        else { chainOk = false; break; }
      }
      if (chainOk && parts.length > 0) {
        const lastPart = parts[parts.length - 1];
        if (lastPart.text === '*' && !lastPart.quoted) star = { qualifier: parts.slice(0, -1) };
        else colRef = { qualifier: parts.slice(0, -1), name: lastPart };
      }
    }
    const p: Projection = { range: [toks[0].start, toks[toks.length - 1].end], alias, aliasRange, colRef, star };
    if (aliasRange) {
      const at = toks.find((t) => t.start === aliasRange![0]);
      if (at && (at.kind === 'quotedIdent' || at.kind === 'string')) p.aliasQuoted = true;
    }
    if (assignment) p.assignment = true;
    return p;
  }

  parseValuesRows(s: Scope): void {
    const v = this.t[this.i];
    this.i++;
    this.mark(s, 'unknown', v.end);
    let first = true;
    while (this.atP('(')) {
      const open = this.t[this.i];
      this.mark(s, 'values', open.end);
      this.i++;
      let count = 0;
      const commaStop = (k: number) => this.t[k].kind === 'punct' && this.t[k].text === ',';
      while (!this.eof() && !this.atP(')')) {
        const a = this.i;
        this.scanExpr(s, commaStop);
        if (this.i > a) count++;
        if (this.atP(',')) { this.i++; continue; }
        if (this.i === a) this.i++;
        if (this.atP(';')) break;
      }
      if (first) { s.valuesCount = count; s.valuesRange = [open.start, this.curStart()]; first = false; }
      if (this.atP(')')) { this.mark(s, 'unknown', this.t[this.i].end); this.i++; }
      if (this.atP(',') && this.atP('(', 1)) { this.i++; continue; }
      break;
    }
  }

  parseQueryClauses(s: Scope): void {
    while (!this.eof()) {
      const k = this.i;
      const c = this.clauseAt(k);
      const tok = this.t[k];
      switch (c) {
        case 'INTO': {
          this.mark(s, 'into', tok.end, { selectInto: true });
          this.i++;
          if (this.tsql) {
            const parts = this.parseName(true);
            if (parts.length) {
              s.intoTemp = parts[parts.length - 1];
              this.m.created.push({
                name: parts[parts.length - 1].text, defRange: parts[parts.length - 1].range, fromScope: s,
                kind: parts[parts.length - 1].text.startsWith('#') ? 'tempTable' : 'table', parts,
              });
            }
          } else {
            this.scanExpr(s, (j) => this.clauseAt(j) === 'FROM' || (this.clauseAt(j) !== null && WHERE_STOPS.has(this.clauseAt(j)!)));
          }
          continue;
        }
        case 'BULK': {
          this.i += 2;
          continue;
        }
        case 'FROM': {
          s.hasFrom = true;
          this.parseFromList(s);
          continue;
        }
        case 'WHERE': {
          s.hasWhere = true;
          this.mark(s, 'where', tok.end);
          this.i++;
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'CONNECT': case 'START': {
          this.i += 2;
          this.mark(s, 'where', this.prevEnd());
          if (this.at('NOCYCLE')) this.i++;
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'GROUP': case 'ORDER': {
          this.i += 2;
          if (this.at('SIBLINGS')) this.i++;
          this.mark(s, c === 'GROUP' ? 'groupBy' : 'orderBy', this.prevEnd());
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'HAVING': {
          this.mark(s, 'having', tok.end);
          this.i++;
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'LIMIT': case 'OFFSET': case 'FETCH': {
          this.i++;
          this.mark(s, 'limit', tok.end);
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && cc !== 'OFFSET' && cc !== 'FETCH' && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'WINDOW': {
          this.i++;
          this.mark(s, 'unknown', tok.end);
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && cc !== 'WINDOW' && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'FOR': {
          this.i++;
          this.mark(s, 'unknown', tok.end);
          if (this.at('UPDATE') && this.at('OF', 1)) {
            this.i += 2;
            this.mark(s, 'where', this.prevEnd());
          }
          this.scanExpr(s, (j) => { const cc = this.clauseAt(j); return !!cc && cc !== 'FOR' && WHERE_STOPS.has(cc); });
          continue;
        }
        case 'OPTION': {
          this.i++;
          if (this.atP('(')) this.skipParens();
          continue;
        }
        case 'RETURNING': {
          this.mark(s, 'returning', tok.end);
          this.i++;
          if (this.pg) {
            // RETURNING items are the statement's output columns (WITH x AS (DELETE … RETURNING *) SELECT … FROM x)
            const stop = (j: number) => (this.t[j].kind === 'punct' && this.t[j].text === ',') || this.clauseAt(j) === 'INTO';
            while (!this.eof()) {
              const a = this.i;
              this.scanExpr(s, stop);
              if (this.i > a) s.projections.push(this.projection(a, this.i));
              if (this.atP(',')) { this.i++; continue; }
              break;
            }
            continue;
          }
          this.scanExpr(s, (j) => this.clauseAt(j) === 'INTO');
          if (this.at('INTO')) { this.i++; this.mark(s, 'into', this.prevEnd(), { selectInto: true }); this.scanExpr(s, () => false); }
          continue;
        }
        case 'UNION': case 'EXCEPT': case 'INTERSECT': case 'MINUS': {
          this.i++;
          if (this.at('ALL') || this.at('DISTINCT')) this.i++;
          s.range[1] = tok.start;
          const br = this.mkScope('select', s, s.outer, this.curStart());
          br.isBranch = true;
          this.parseSelectBody(br);
          this.endScope(br);
          return;
        }
        default:
          return;
      }
    }
  }

  parseFromList(s: Scope): void {
    const from = this.t[this.i];
    this.mark(s, 'from', from.end);
    this.i++;
    this.parseSourceList(s);
  }

  parseSourceList(s: Scope): void {
    for (;;) {
      this.parseTableSource(s, false);
      this.parseJoins(s);
      if (this.atP(',')) {
        this.mark(s, 'from', this.t[this.i].end);
        this.i++;
        continue;
      }
      return;
    }
  }

  parseJoins(s: Scope): void {
    for (;;) {
      const j = this.joinAt();
      if (!j) return;
      this.i += j.len;
      this.mark(s, 'join', this.prevEnd());
      const ref = this.parseTableSource(s, j.apply);
      if (ref && this.at('ON')) {
        const on = this.t[this.i];
        this.mark(s, 'on', on.end, { joinRef: ref });
        this.i++;
        const a = on.end;
        this.scanExpr(s, (k) => {
          const t = this.t[k];
          if (t.kind === 'punct' && t.text === ',') return true;
          const cc = this.clauseAt(k);
          if (cc && AFTER_FROM_STOPS.has(cc) && cc !== 'ON') return true;
          return this.joinAtIndex(k);
        });
        s.joins.push({ right: ref, onRange: [a, this.curStart()], kind: 'join' });
      } else if (ref && this.at('USING')) {
        this.mark(s, 'using', this.t[this.i].end, { joinRef: ref });
        this.i++;
        if (this.atP('(')) this.skipParens();
        s.joins.push({ right: ref, onRange: null, kind: 'using' });
      } else if (ref) {
        s.joins.push({ right: ref, onRange: null, kind: j.apply ? 'apply' : 'cross' });
      }
    }
  }

  joinAtIndex(k: number): boolean {
    const save = this.i;
    this.i = k;
    const j = this.joinAt();
    this.i = save;
    return !!j;
  }

  /** Table source with optional alias; pushes into s.sources. */
  parseTableSource(s: Scope, lateral: boolean, target = false): TableRef | null {
    const tok = this.peek();
    if (!tok) return null;
    const start = tok.start;
    let ref: TableRef | null = null;
    if (tok.kind === 'punct' && tok.text === '(') {
      const nx = this.peek(1);
      if (nx && (nx.upper === 'SELECT' || nx.upper === 'WITH')) {
        this.i++;
        const sub = this.parseQuery(s, 'subquery', lateral ? s : null);
        if (this.atP(')')) this.i++;
        ref = { kind: 'subquery', parts: [], alias: null, aliasRange: null, nameRange: [tok.start, this.prevEnd()], range: [start, start], subScope: sub };
      } else if (nx && nx.upper === 'VALUES') {
        this.i++;
        const sub = this.mkScope('values', s, null, nx.start);
        this.parseValuesRows(sub);
        this.endScope(sub);
        if (this.atP(')')) this.i++;
        ref = { kind: 'values', parts: [], alias: null, aliasRange: null, nameRange: [tok.start, this.prevEnd()], range: [start, start], subScope: sub };
      } else {
        // parenthesised join group
        this.i++;
        this.parseSourceList(s);
        if (this.atP(')')) this.i++;
        return null;
      }
    } else if (isWord(tok) && (tok.upper === 'LATERAL') && (this.atP('(', 1) || (this.pg && isNameTok(this.peek(1))))) {
      this.i++;
      return this.parseTableSource(s, true, target);
    } else if (this.pg && isWord(tok) && tok.upper === 'ONLY' && isNameTok(this.peek(1))) {
      this.i++;
      return this.parseTableSource(s, lateral, target);
    } else if (isNameTok(tok) || (tok.kind === 'param' && this.tsql)) {
      if (isWord(tok) && (this.clauseAt(this.i) !== null || this.joinAt() !== null)) return null;
      if (isWord(tok) && tok.kind === 'keyword' && !['LEFT', 'RIGHT', 'TABLE'].includes(tok.upper) && this.spec.statementStarts.has(tok.upper)) return null;
      const parts = this.parseName(true);
      if (this.atP('.')) { this.i++; return null; } // incomplete qualified name being typed
      const last = parts[parts.length - 1];
      let kind: TableRef['kind'] = 'table';
      if (parts.length === 1 && last.text.startsWith('@')) kind = 'tableVar';
      else if (last && last.text.startsWith('#') && !last.quoted) kind = 'tempTable';
      ref = { kind, parts, alias: null, aliasRange: null, nameRange: [parts[0].range[0], last.range[1]], range: [start, start] };
      if (this.ora && this.atOp('@')) {
        this.i++;
        this.parseName();
        ref.remote = true;
      }
      if (parts.length >= 4) ref.remote = true;
      if (this.atP('(')) {
        const a = this.t[this.i].end;
        ref.kind = 'function';
        // arguments may contain correlated references
        this.i++;
        this.scanExpr(s, () => false);
        ref.argsRange = [a, this.curStart()];
        if (this.atP(')')) this.i++;
        if (this.pg && this.at('WITH') && this.at('ORDINALITY', 1)) { this.i += 2; ref.withOrdinality = true; }
      }
    } else {
      return null;
    }
    // modifiers before alias
    this.skipTableModifiers();
    if (this.at('AS')) {
      this.i++;
      const at = this.peek();
      if (isNameTok(at)) {
        ref.alias = namePart(at!).text;
        ref.aliasQuoted = at!.kind === 'quotedIdent';
        ref.aliasRange = [at!.start, at!.end];
        this.i++;
      }
    } else if (this.isAliasCandidate(this.peek()) && !(this.lite && this.at('INDEXED'))) {
      const at = this.peek()!;
      ref.alias = namePart(at).text;
      ref.aliasQuoted = at.kind === 'quotedIdent';
      ref.aliasRange = [at.start, at.end];
      this.i++;
    }
    if (this.atP('(') && (ref.kind === 'subquery' || ref.kind === 'values' || ref.kind === 'function') && ref.alias) {
      // alias column list: `AS g(n)`, or a column definition list `AS x(a int, b numeric(10, 2))` (first name per item)
      const cols: string[] = [];
      this.i++;
      let depth = 0;
      let expectName = true;
      while (!this.eof() && !(depth === 0 && this.atP(')'))) {
        const ct = this.t[this.i];
        if (ct.kind === 'punct' && ct.text === '(') depth++;
        else if (ct.kind === 'punct' && ct.text === ')') depth--;
        else if (depth === 0 && ct.kind === 'punct' && ct.text === ',') expectName = true;
        else if (expectName && depth === 0 && isNameTok(ct)) { cols.push(namePart(ct).text); expectName = false; }
        this.i++;
      }
      if (this.atP(')')) this.i++;
      ref.columnAliases = cols;
    }
    this.skipTableModifiers();
    if ((this.at('PIVOT') || this.at('UNPIVOT')) && this.atP('(', 1)) {
      this.i++;
      this.skipParens();
      if (this.at('AS')) this.i++;
      if (this.isAliasCandidate(this.peek())) this.i++;
    }
    ref.range = [start, this.prevEnd()];
    if (target) ref.isTarget = true;
    s.sources.push(ref);
    return ref;
  }

  skipTableModifiers(): void {
    for (;;) {
      if (this.tsql && this.at('WITH') && this.atP('(', 1)) { this.i++; this.skipParens(); continue; }
      if (this.tsql && this.at('FOR') && this.at('SYSTEM_TIME', 1)) {
        this.i += 2;
        while (!this.eof() && (this.peek()!.kind === 'string' || ['AS', 'OF', 'FROM', 'TO', 'BETWEEN', 'AND', 'CONTAINED', 'IN', 'ALL'].includes(this.u()))) {
          if (this.atP('(')) this.skipParens(); else this.i++;
        }
        continue;
      }
      if ((this.at('TABLESAMPLE') || (this.ora && (this.at('SAMPLE') || this.at('PARTITION') || this.at('SUBPARTITION')))) && !this.eof()) {
        this.i++;
        if (this.at('BLOCK')) this.i++;
        if (this.atP('(')) this.skipParens();
        continue;
      }
      if (this.ora && this.at('AS') && this.at('OF', 1)) {
        this.i += 3;
        this.scanExpr(this.m.root, (k) => this.isAliasCandidate(this.t[k]) || this.clauseAt(k) !== null);
        continue;
      }
      if (this.lite && this.at('INDEXED') && this.at('BY', 1)) { this.i += 3; continue; }
      if (this.lite && this.at('NOT') && this.at('INDEXED', 1)) { this.i += 2; continue; }
      return;
    }
  }

  // ------------------------------------------------------------ DML

  parseInsert(s: Scope): void {
    const ins = this.t[this.i];
    s.kind = 'insert';
    this.i++;
    if (this.at('OR')) { this.i += 2; }
    if (this.at('ALL') || this.at('FIRST')) this.i++;
    if (this.tsql && this.at('TOP')) { this.i++; if (this.atP('(')) this.skipParens(); if (this.at('PERCENT')) this.i++; }
    let kwEnd = ins.end;
    if (this.at('INTO')) { kwEnd = this.t[this.i].end; this.i++; }
    this.mark(s, 'into', kwEnd);
    const tt = this.peek();
    if (tt && (isNameTok(tt) || tt.kind === 'param') && !(isWord(tt) && ['SELECT', 'VALUES', 'DEFAULT'].includes(tt.upper))) {
      const parts = this.parseName(true);
      const last = parts[parts.length - 1];
      const ref: TableRef = {
        kind: last.text.startsWith('#') ? 'tempTable' : last.text.startsWith('@') ? 'tableVar' : 'table', parts,
        alias: null, aliasRange: null, nameRange: [parts[0].range[0], last.range[1]], range: [parts[0].range[0], last.range[1]], isTarget: true,
      };
      if (this.tsql && this.at('WITH') && this.atP('(', 1)) { this.i++; this.skipParens(); }
      if ((this.lite || this.ora || this.pg) && (this.at('AS') || (this.ora && this.isAliasCandidate(this.peek()) && !this.atP('(')))) {
        if (this.at('AS')) this.i++;
        const at = this.peek();
        if (isNameTok(at)) { ref.alias = namePart(at!).text; ref.aliasRange = [at!.start, at!.end]; this.i++; }
      }
      s.targetTable = ref;
    }
    if (this.atP('(') && !(this.at('SELECT', 1) || this.at('WITH', 1))) {
      const open = this.t[this.i];
      this.mark(s, 'insertColumns', open.end);
      this.i++;
      const cols: NamePart[] = [];
      while (!this.eof() && !this.atP(')')) {
        const ct = this.t[this.i];
        if (isNameTok(ct)) cols.push(namePart(ct));
        else if (!(ct.kind === 'punct' && ct.text === ',')) break;
        this.i++;
      }
      s.insertColumns = cols;
      if (this.atP(')')) { this.mark(s, 'unknown', this.t[this.i].end); this.i++; }
    }
    if (this.pg && this.at('OVERRIDING')) {
      this.i++;
      while (this.at('SYSTEM') || this.at('USER') || this.at('VALUE')) this.i++;
      this.mark(s, 'unknown', this.prevEnd());
    }
    if (this.tsql && this.at('OUTPUT')) {
      this.mark(s, 'unknown', this.t[this.i].end);
      this.i++;
      this.scanExpr(s, (k) => ['VALUES', 'SELECT', 'DEFAULT', 'EXEC', 'EXECUTE', 'INTO'].includes(this.t[k].upper));
      if (this.at('INTO')) { this.i++; this.parseName(true); if (this.atP('(')) this.skipParens(); }
    }
    if (this.at('VALUES')) {
      this.parseValuesRows(s);
    } else if (this.at('SELECT') || this.at('WITH') || (this.atP('(') && (this.at('SELECT', 1) || this.at('WITH', 1)))) {
      this.parseQuery(s, 'select', null);
    } else if (this.at('DEFAULT') && this.at('VALUES', 1)) {
      this.i += 2;
    } else if (this.at('EXEC') || this.at('EXECUTE')) {
      this.parseExec(s);
    }
    // SQLite upsert / RETURNING, Oracle RETURNING / LOG ERRORS
    while (!this.eof() && !this.atP(';')) {
      if (this.at('ON') && this.at('CONFLICT', 1)) {
        this.i += 2;
        if (this.pg) this.mark(s, 'unknown', this.prevEnd(), { conflict: 'target' });
        if (this.atP('(')) {
          this.mark(s, 'insertColumns', this.t[this.i].end, this.pg ? { conflict: 'columns' } : undefined);
          this.skipParens();
          if (this.pg && this.t[this.i - 1]?.text === ')' && this.t[this.i - 1].kind === 'punct') this.mark(s, 'unknown', this.prevEnd(), { conflict: 'action' });
        } else if (this.pg && this.at('ON') && this.at('CONSTRAINT', 1)) {
          this.i += 2;
          if (isNameTok(this.peek())) this.i++;
          this.mark(s, 'unknown', this.prevEnd(), { conflict: 'action' });
        }
        if (this.at('WHERE')) {
          this.i++;
          if (this.pg && s.targetTable && !s.sources.includes(s.targetTable)) s.sources.push(s.targetTable);
          this.mark(s, 'where', this.prevEnd());
          this.scanExpr(s, (k) => this.t[k].upper === 'DO');
          if (this.pg) this.mark(s, 'unknown', this.prevEnd(), { conflict: 'action' });
        }
        if (this.at('DO')) { this.i++; if (this.pg) this.mark(s, 'unknown', this.prevEnd(), { conflict: 'do' }); }
        if (this.at('NOTHING')) { this.i++; if (this.pg) this.mark(s, 'unknown', this.prevEnd()); continue; }
        if (this.at('UPDATE') && this.at('SET', 1)) {
          this.i++;
          if (s.targetTable && !s.sources.includes(s.targetTable)) s.sources.push(s.targetTable);
          this.parseSetClause(s);
          if (this.at('WHERE')) { s.hasWhere = true; this.mark(s, 'where', this.t[this.i].end); this.i++; this.scanExpr(s, (k) => this.clauseAt(k) === 'RETURNING'); }
        }
        continue;
      }
      if (this.at('RETURNING')) {
        if (s.targetTable && !s.sources.includes(s.targetTable)) s.sources.push(s.targetTable);
        this.parseQueryClauses(s);
        continue;
      }
      break;
    }
    this.endScope(s);
  }

  parseSetClause(s: Scope): void {
    const set = this.t[this.i];
    this.mark(s, 'set', set.end);
    this.i++;
    const stop = (k: number) => {
      const t = this.t[k];
      if (t.kind === 'punct' && t.text === ',') return true;
      const cc = this.clauseAt(k);
      return cc === 'FROM' || cc === 'WHERE' || cc === 'OUTPUT' || cc === 'RETURNING' || cc === 'WHEN' || cc === 'ORDER' || cc === 'LIMIT';
    };
    while (!this.eof()) {
      const a = this.i;
      this.scanExpr(s, stop);
      if (this.atP(',')) { this.i++; continue; }
      if (this.i === a) break;
      break;
    }
  }

  parseUpdate(s: Scope): void {
    const up = this.t[this.i];
    s.kind = 'update';
    this.i++;
    if (this.lite && this.at('OR')) this.i += 2;
    if (this.tsql && this.at('TOP')) { this.i++; if (this.atP('(')) this.skipParens(); if (this.at('PERCENT')) this.i++; }
    this.mark(s, 'update', up.end);
    const ref = this.parseTableSource(s, false, true);
    if (ref) s.targetTable = ref;
    if (this.at('SET')) this.parseSetClause(s);
    if (this.tsql && this.at('OUTPUT')) {
      this.i++;
      this.scanExpr(s, (k) => this.clauseAt(k) === 'FROM' || this.clauseAt(k) === 'WHERE' || this.clauseAt(k) === 'INTO');
      if (this.at('INTO')) { this.i++; this.parseName(true); if (this.atP('(')) this.skipParens(); }
    }
    if (this.at('FROM')) { s.hasFrom = true; this.parseFromList(s); }
    if (this.at('WHERE')) {
      s.hasWhere = true;
      this.mark(s, 'where', this.t[this.i].end);
      this.i++;
      this.scanExpr(s, (k) => { const cc = this.clauseAt(k); return !!cc && WHERE_STOPS.has(cc); });
    }
    this.parseQueryClauses(s);
    this.endScope(s);
  }

  parseDelete(s: Scope): void {
    const del = this.t[this.i];
    s.kind = 'delete';
    this.i++;
    if (this.tsql && this.at('TOP')) { this.i++; if (this.atP('(')) this.skipParens(); if (this.at('PERCENT')) this.i++; }
    let kwEnd = del.end;
    if (this.at('FROM')) { kwEnd = this.t[this.i].end; this.i++; }
    this.mark(s, 'delete', kwEnd);
    const ref = this.parseTableSource(s, false, true);
    if (ref) s.targetTable = ref;
    if (this.tsql && this.at('OUTPUT')) {
      this.i++;
      this.scanExpr(s, (k) => this.clauseAt(k) === 'FROM' || this.clauseAt(k) === 'WHERE' || this.clauseAt(k) === 'INTO');
      if (this.at('INTO')) { this.i++; this.parseName(true); if (this.atP('(')) this.skipParens(); }
    }
    if (this.at('FROM')) { s.hasFrom = true; this.parseFromList(s); }
    if (this.pg && this.at('USING')) {
      // DELETE FROM t USING u, v WHERE …: the USING sources join the scope
      s.hasFrom = true;
      this.mark(s, 'from', this.t[this.i].end);
      this.i++;
      this.parseSourceList(s);
    }
    if (this.at('WHERE')) {
      s.hasWhere = true;
      this.mark(s, 'where', this.t[this.i].end);
      this.i++;
      this.scanExpr(s, (k) => { const cc = this.clauseAt(k); return !!cc && WHERE_STOPS.has(cc); });
    }
    this.parseQueryClauses(s);
    this.endScope(s);
  }

  parseMerge(s: Scope): void {
    const mg = this.t[this.i];
    s.kind = 'merge';
    this.i++;
    if (this.tsql && this.at('TOP')) { this.i++; if (this.atP('(')) this.skipParens(); }
    let kwEnd = mg.end;
    if (this.at('INTO')) { kwEnd = this.t[this.i].end; this.i++; }
    this.mark(s, 'into', kwEnd);
    const target = this.parseTableSource(s, false, true);
    if (target) s.targetTable = target;
    let source: TableRef | null = null;
    if (this.at('USING')) {
      this.mark(s, 'using', this.t[this.i].end);
      this.i++;
      source = this.parseTableSource(s, false);
    }
    if (this.at('ON')) {
      const on = this.t[this.i];
      this.mark(s, 'on', on.end, source ? { joinRef: source } : undefined);
      this.i++;
      this.scanExpr(s, (k) => this.clauseAt(k) === 'WHEN');
      if (source) s.joins.push({ right: source, onRange: [on.end, this.curStart()], kind: 'merge' });
    }
    while (this.at('WHEN')) {
      this.i++;
      this.mark(s, 'unknown', this.prevEnd());
      while (!this.eof() && !this.at('THEN') && !this.atP(';')) {
        if (this.at('AND')) { this.i++; this.mark(s, 'where', this.prevEnd()); this.scanExpr(s, (k) => this.t[k].upper === 'THEN'); continue; }
        this.i++;
      }
      if (!this.at('THEN')) break;
      this.i++;
      this.mark(s, 'unknown', this.prevEnd());
      if (this.at('UPDATE') && this.at('SET', 1)) {
        this.i++;
        this.parseSetClause(s);
        if (this.at('WHERE')) { this.i++; this.mark(s, 'where', this.prevEnd()); this.scanExpr(s, (k) => this.clauseAt(k) === 'WHEN' || this.t[k].upper === 'DELETE'); }
        if (this.at('DELETE')) { this.i++; if (this.at('WHERE')) { this.i++; this.scanExpr(s, (k) => this.clauseAt(k) === 'WHEN'); } }
      } else if (this.at('DELETE')) {
        this.i++;
      } else if (this.at('INSERT')) {
        this.i++;
        if (this.atP('(')) {
          this.mark(s, 'insertColumns', this.t[this.i].end);
          this.i++;
          const cols: NamePart[] = [];
          while (!this.eof() && !this.atP(')')) {
            const ct = this.t[this.i];
            if (isNameTok(ct)) cols.push(namePart(ct));
            this.i++;
          }
          s.insertColumns = cols;
          if (this.atP(')')) this.i++;
        }
        if (this.at('VALUES')) {
          this.i++;
          if (this.atP('(')) {
            this.mark(s, 'where', this.t[this.i].end);
            this.i++;
            this.scanExpr(s, () => false);
            if (this.atP(')')) this.i++;
          }
        }
      }
    }
    if (this.tsql && this.at('OUTPUT')) { this.i++; this.scanExpr(s, () => false); }
    this.endScope(s);
  }

  parseExec(c: Scope): void {
    const ex = this.t[this.i];
    this.i++;
    this.mark(c, 'exec', ex.end);
    if (this.atP('(')) { this.skipParens(); return; }
    if (this.peek()?.kind === 'param' && this.atOp('=', 1)) {
      this.i += 2;
      this.mark(c, 'exec', this.prevEnd());
    }
    const parts = this.parseName();
    if (!parts.length) return;
    this.mark(c, 'execArgs', parts[parts.length - 1].range[1], { proc: parts });
    if (this.atP('(')) {
      this.i++;
      this.scanExpr(c, () => false);
      if (this.atP(')')) this.i++;
      return;
    }
    this.scanExpr(c, () => false);
  }

  // ------------------------------------------------------------ T-SQL procedural

  parseTsqlDeclare(c: Scope): void {
    const d = this.t[this.i];
    this.mark(c, 'declare', d.end);
    this.i++;
    while (!this.eof()) {
      const t = this.peek()!;
      if (t.kind === 'param') {
        this.i++;
        if (this.at('AS')) this.i++;
        this.mark(c, 'declare', this.prevEnd(), { expectType: true });
        const v: VarDef = { name: t.text, kind: 'var', type: '', range: [t.start, t.end] };
        if (this.at('TABLE')) {
          this.i++;
          v.kind = 'tableVar';
          v.type = 'TABLE';
          v.columns = this.atP('(') ? this.parseColumnDefs(c) : [];
          this.m.created.push({ name: t.text, defRange: [t.start, t.end], columns: v.columns, kind: 'tableVar' });
        } else if (this.at('CURSOR')) {
          this.i++;
          v.kind = 'cursor';
          v.type = 'CURSOR';
        } else {
          v.type = this.readType();
          if (this.atOp('=')) {
            this.i++;
            this.mark(c, 'expr', this.prevEnd());
            this.scanExpr(c, (k) => this.t[k].kind === 'punct' && this.t[k].text === ',');
          }
        }
        c.localVars.set(this.varKey(v.name), v);
        this.m.declared.push(v);
      } else if (isNameTok(t)) {
        // DECLARE c [INSENSITIVE|SCROLL] CURSOR [options] FOR select
        this.i++;
        const v: VarDef = { name: namePart(t).text, kind: 'cursor', type: 'CURSOR', range: [t.start, t.end] };
        while (!this.eof() && !this.at('FOR') && !this.atP(';') && !this.atP(',')) this.i++;
        if (this.at('FOR')) {
          this.i++;
          v.query = this.parseQuery(c, 'select', null);
          if (this.at('FOR') && this.at('UPDATE', 1)) { this.i += 2; this.scanExpr(c, () => false); }
        }
        c.localVars.set(this.varKey(v.name), v);
        this.m.declared.push(v);
      } else break;
      if (this.atP(',')) {
        this.mark(c, 'declare', this.t[this.i].end);
        this.i++;
        continue;
      }
      break;
    }
  }

  /** Data type text: `nvarchar(50)`, `decimal(18,2)`, `varchar(max)`, `t.col%TYPE`. */
  readType(): string {
    const a = this.i;
    const t = this.peek();
    if (!isNameTok(t)) return '';
    this.parseName();
    // multi-word types: DOUBLE PRECISION, TIMESTAMP WITH TIME ZONE, INTERVAL DAY TO SECOND, CHARACTER VARYING
    while (['PRECISION', 'VARYING', 'WITH', 'LOCAL', 'TIME', 'ZONE', 'DAY', 'YEAR', 'MONTH', 'TO', 'SECOND', 'UNSIGNED', 'CHAR', 'BYTE'].includes(this.u()) &&
      !(this.at('WITH') && !this.at('TIME', 1) && !this.at('LOCAL', 1))) this.i++;
    if (this.atP('(')) this.skipParens();
    if (this.atOp(ORACLE_ATTR_TYPE) || this.atOp(ORACLE_ATTR_ROWTYPE)) this.i++;
    const b = this.i;
    if (b <= a) return '';
    let out = '';
    for (let k = a; k < b; k++) {
      const x = this.t[k];
      if (k > a && isNameTok(x) && isNameTok(this.t[k - 1])) out += ' ';
      out += x.text;
      if (x.kind === 'punct' && x.text === ',') out += ' ';
    }
    return out;
  }

  /** `( col type constraints, ... )` → column defs. Leaves the cursor after ')'. */
  parseColumnDefs(c: Scope, owner?: TableRef): ColumnDef[] {
    const cols: ColumnDef[] = [];
    if (!this.atP('(')) return cols;
    this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnName' } });
    this.i++;
    while (!this.eof() && !this.atP(')')) {
      const t = this.peek()!;
      if (isWord(t) && TABLE_CONSTRAINT_STARTS.has(t.upper)) {
        this.skipColumnDefRest(c, owner);
      } else if (isNameTok(t)) {
        this.i++;
        const np = namePart(t);
        this.mark(c, 'ddl', t.end, { ddl: { what: 'dataType' } });
        const type = this.readType();
        const col: ColumnDef = { name: np.text, type, ordinal: cols.length + 1, defRange: np.range, nullable: true };
        // constraints
        while (!this.eof() && !this.atP(',') && !this.atP(')')) {
          if (this.at('NOT') && this.at('NULL', 1)) { col.nullable = false; this.i += 2; continue; }
          if (this.at('PRIMARY') && this.at('KEY', 1)) { col.isPk = true; col.nullable = false; this.i += 2; continue; }
          if (this.at('IDENTITY') || this.at('AUTOINCREMENT')) { col.identity = true; this.i++; if (this.atP('(')) this.skipParens(); continue; }
          if (this.at('AS') && this.atP('(', 1)) { col.computed = true; this.i++; this.skipParens(); continue; }
          if (this.at('REFERENCES')) {
            this.i++;
            this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
            this.parseName();
            if (this.atP('(')) this.skipParens();
            continue;
          }
          if (this.atP('(')) { this.skipParens(); continue; }
          this.i++;
        }
        cols.push(col);
      } else {
        this.i++;
      }
      if (this.atP(',')) {
        this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnName' } });
        this.i++;
      }
    }
    if (this.atP(')')) this.i++;
    return cols;
  }

  skipColumnDefRest(c: Scope, owner?: TableRef): void {
    while (!this.eof() && !this.atP(',') && !this.atP(')')) {
      if (this.at('REFERENCES')) {
        this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
        this.parseName();
        if (this.atP('(')) this.skipParens();
        continue;
      }
      if (this.atP('(')) {
        if (owner) this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnOf', table: owner } });
        this.skipParens();
        continue;
      }
      this.i++;
    }
  }

  parseTsqlIf(c: Scope): void {
    const kw = this.t[this.i];
    this.i++;
    this.mark(c, 'expr', kw.end);
    this.scanExpr(c, () => false);
    this.mark(c, 'unknown', this.prevEnd(), { statementStart: true });
    if (!this.eof() && !this.at('ELSE') && !this.at('END')) this.parseStatement(c);
    if (this.atP(';') && this.at('ELSE', 1)) this.i++;
    if (kw.upper === 'IF' && this.at('ELSE')) {
      this.i++;
      this.mark(c, 'unknown', this.prevEnd(), { statementStart: true });
      if (!this.eof()) this.parseStatement(c);
    }
  }

  parseTsqlSet(c: Scope): void {
    const set = this.t[this.i];
    this.i++;
    const t = this.peek();
    if (t && t.kind === 'param') {
      this.mark(c, 'expr', set.end);
      this.i++;
      if (this.peek()?.kind === 'op') {
        this.i++;
        this.mark(c, 'expr', this.prevEnd());
      }
      this.scanExpr(c, () => false);
      return;
    }
    // SET options: SET NOCOUNT ON, SET TRANSACTION ISOLATION LEVEL ...
    this.mark(c, 'unknown', set.end);
    while (!this.eof() && !this.atP(';')) {
      const x = this.t[this.i];
      if (x !== t && this.isTsqlStmtStart(x, this.i)) return;
      this.i++;
    }
  }

  // ------------------------------------------------------------ DDL

  parseCreate(c: Scope): void {
    const cr = this.t[this.i];
    this.i++;
    while (CREATE_MODIFIERS.has(this.u())) this.i++;
    if (this.at('MATERIALIZED')) this.i++;
    const objTok = this.peek();
    if (!objTok) { this.mark(c, 'ddl', cr.end, { ddl: { what: 'newName' } }); return; }
    const obj = this.u();
    this.i++;
    switch (obj) {
      case 'TABLE': {
        if (this.at('IF') && this.at('NOT', 1)) this.i += 3;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
        const parts = this.parseName();
        if (!parts.length) return;
        const last = parts[parts.length - 1];
        const ref: TableRef = { kind: 'table', parts, alias: null, aliasRange: null, nameRange: [parts[0].range[0], last.range[1]], range: [parts[0].range[0], last.range[1]] };
        const def: TempTableDef = { name: last.text, defRange: last.range, kind: last.text.startsWith('#') ? 'tempTable' : 'table', parts };
        if (this.atP('(')) def.columns = this.parseColumnDefs(c, ref);
        while (!this.eof() && !this.at('AS') && !this.atP(';') && !this.isTsqlStmtStart(this.t[this.i], this.i)) {
          if (this.atP('(')) this.skipParens(); else this.i++;
        }
        if (this.at('AS')) {
          this.i++;
          if (this.at('SELECT') || this.at('WITH') || this.atP('(')) def.fromScope = this.parseQuery(c, 'select', null);
        }
        this.m.created.push(def);
        return;
      }
      case 'VIEW': {
        if (this.at('IF') && this.at('NOT', 1)) this.i += 3;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
        this.parseName();
        if (this.atP('(')) this.skipParens();
        while (!this.eof() && !this.at('AS')) this.i++;
        if (this.at('AS')) {
          this.i++;
          this.parseQuery(c, 'select', null);
          if (this.at('WITH')) { while (!this.eof() && !this.atP(';')) this.i++; }
        }
        return;
      }
      case 'INDEX': {
        if (this.pg && this.at('CONCURRENTLY')) this.i++;
        if (this.at('IF') && this.at('NOT', 1)) this.i += 3;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
        if (!(this.pg && this.at('ON'))) this.parseName();
        if (this.at('ON')) {
          this.i++;
          if (this.pg && this.at('ONLY')) this.i++;
          this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
          const parts = this.parseName();
          const ref: TableRef | undefined = parts.length ? { kind: 'table', parts, alias: null, aliasRange: null, nameRange: [parts[0].range[0], parts[parts.length - 1].range[1]], range: [parts[0].range[0], parts[parts.length - 1].range[1]] } : undefined;
          if (this.pg && this.at('USING') && isNameTok(this.peek(1))) this.i += 2;
          if (this.atP('(') && ref) {
            this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnOf', table: ref } });
            this.skipParens();
          }
          if (this.pg && ref) {
            // INCLUDE (cols) / WITH (storage) / WHERE predicate over the table's columns
            while (!this.eof() && !this.atP(';')) {
              if (this.at('INCLUDE') && this.atP('(', 1)) { this.i++; this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnOf', table: ref } }); this.skipParens(); continue; }
              if (this.at('WHERE')) {
                const w = this.mkScope('select', c, null, this.t[this.i].start);
                w.sources.push({ ...ref });
                this.i++;
                this.mark(w, 'where', this.prevEnd());
                this.scanExpr(w, () => false);
                this.endScope(w);
                continue;
              }
              if (this.atP('(')) this.skipParens(); else this.i++;
            }
          }
        }
        return;
      }
      case 'PROC': case 'PROCEDURE': case 'FUNCTION': case 'TRIGGER': case 'PACKAGE': case 'TYPE':
        if (this.pg && (obj === 'FUNCTION' || obj === 'PROCEDURE')) { this.parsePgRoutine(c); return; }
        if (this.pg && obj === 'TRIGGER') { this.parsePgTrigger(c); return; }
        if (this.tsql) { this.parseTsqlRoutine(c, obj); return; }
        if (this.ora) { this.parsePlsqlUnit(c, obj); return; }
        if (this.lite && obj === 'TRIGGER') { this.parseSqliteTrigger(c); return; }
        break;
      case 'SEQUENCE': case 'SYNONYM': case 'SCHEMA': case 'USER': case 'ROLE': case 'DATABASE': case 'LOGIN':
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
        if (obj === 'SYNONYM') {
          this.parseName();
          if (this.at('FOR')) { this.i++; this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'ANY' } }); this.parseName(); }
        }
        break;
    }
    while (!this.eof() && !this.atP(';')) {
      if (this.isTsqlStmtStart(this.t[this.i], this.i) && this.t[this.i] !== objTok) return;
      this.i++;
    }
  }

  parseTsqlRoutine(c: Scope, obj: string): void {
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
    this.parseName();
    if (obj === 'TRIGGER') {
      if (this.at('ON')) {
        this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
        const parts = this.parseName();
        if (parts.length) {
          for (const pseudo of ['inserted', 'deleted']) {
            this.m.created.push({ name: pseudo, defRange: [parts[0].range[0], parts[parts.length - 1].range[1]], kind: 'table', parts: [{ text: pseudo, quoted: false, range: parts[0].range }], likeParts: parts });
          }
        }
      }
    } else {
      // parameters, with or without parentheses
      const paren = this.atP('(');
      if (paren) this.i++;
      while (!this.eof()) {
        const t = this.peek()!;
        if (t.kind === 'param') {
          this.i++;
          if (this.at('AS')) this.i++;
          this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'dataType' } });
          const type = this.readType();
          const v: VarDef = { name: t.text, kind: 'param', type, range: [t.start, t.end], direction: 'in' };
          while (!this.eof() && !this.atP(',') && !this.atP(')') && !this.at('AS') && !this.at('RETURNS') && !this.at('WITH')) {
            if (this.at('OUT') || this.at('OUTPUT')) v.direction = 'out';
            if (this.atP('(')) this.skipParens(); else this.i++;
          }
          c.localVars.set(this.varKey(v.name), v);
          if (this.atP(',')) { this.i++; continue; }
        }
        break;
      }
      if (paren && this.atP(')')) this.i++;
      if (this.at('RETURNS')) {
        this.i++;
        if (this.peek()?.kind === 'param') {
          const rv = this.t[this.i];
          this.i++;
          if (this.at('TABLE')) {
            this.i++;
            const cols = this.parseColumnDefs(c);
            c.localVars.set(this.varKey(rv.text), { name: rv.text, kind: 'tableVar', type: 'TABLE', range: [rv.start, rv.end], columns: cols });
            this.m.created.push({ name: rv.text, defRange: [rv.start, rv.end], columns: cols, kind: 'tableVar' });
          }
        } else this.readType();
      }
    }
    while (!this.eof() && !this.at('AS')) {
      if (this.atP('(')) this.skipParens(); else this.i++;
    }
    if (this.at('AS')) {
      this.i++;
      this.mark(c, 'unknown', this.prevEnd(), { statementStart: true });
      if (this.at('RETURN') && (this.atP('(', 1) || this.at('SELECT', 1) || this.at('WITH', 1))) {
        this.i++;
        const paren2 = this.atP('(');
        if (paren2) this.i++;
        this.parseQuery(c, 'select', null);
        if (paren2 && this.atP(')')) this.i++;
        return;
      }
      this.parseStatementList(c, new Set());
    }
  }

  parseSqliteTrigger(c: Scope): void {
    if (this.at('IF') && this.at('NOT', 1)) this.i += 3;
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
    this.parseName();
    while (!this.eof() && !this.at('ON')) this.i++;
    let table: NamePart[] = [];
    if (this.at('ON')) {
      this.i++;
      this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
      table = this.parseName();
    }
    const blk = this.mkScope('plsqlBlock', c, null, this.curStart());
    if (table.length) {
      for (const nm of ['NEW', 'OLD']) blk.localVars.set(nm, { name: nm.toLowerCase(), kind: 'record', type: 'ROW', range: table[0].range, rowtypeOf: table });
    }
    while (!this.eof() && !this.at('BEGIN')) {
      if (this.at('WHEN')) { this.i++; this.mark(blk, 'where', this.prevEnd()); this.scanExpr(blk, (k) => this.t[k].upper === 'BEGIN'); continue; }
      this.i++;
    }
    if (this.at('BEGIN')) {
      this.i++;
      this.mark(blk, 'unknown', this.prevEnd(), { statementStart: true });
      this.parseStatementList(blk, wordSet('END'));
      if (this.at('END')) this.i++;
    }
    this.endScope(blk);
  }

  parseAlter(c: Scope): void {
    this.i++;
    const obj = this.u();
    if (this.tsql && ['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'].includes(obj)) {
      this.i++;
      if (obj === 'VIEW') {
        this.parseName();
        while (!this.eof() && !this.at('AS')) this.i++;
        if (this.at('AS')) { this.i++; this.parseQuery(c, 'select', null); }
        return;
      }
      this.parseTsqlRoutine(c, obj);
      return;
    }
    if (obj !== 'TABLE') {
      if (obj) { this.i++; this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: obj } }); }
      while (!this.eof() && !this.atP(';')) {
        if (this.isTsqlStmtStart(this.t[this.i], this.i)) return;
        this.i++;
      }
      return;
    }
    this.i++;
    if (this.at('IF') && this.at('EXISTS', 1)) this.i += 2;
    if (this.pg && this.at('ONLY')) this.i++;
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
    const parts = this.parseName();
    if (!parts.length) return;
    const ref: TableRef = { kind: 'table', parts, alias: null, aliasRange: null, nameRange: [parts[0].range[0], parts[parts.length - 1].range[1]], range: [parts[0].range[0], parts[parts.length - 1].range[1]] };
    while (!this.eof() && !this.atP(';')) {
      const u = this.u();
      if (this.isTsqlStmtStart(this.t[this.i], this.i) && u !== 'ALTER' && u !== 'DROP' && u !== 'SET') return;
      if ((u === 'ALTER' || u === 'DROP' || u === 'RENAME') && this.at('COLUMN', 1)) {
        this.i += 2;
        if (this.at('IF') && this.at('EXISTS', 1)) this.i += 2;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'columnOf', table: ref } });
        continue;
      }
      if (u === 'MODIFY' || (u === 'DROP' && this.atP('(', 1))) {
        this.i++;
        if (this.atP('(')) this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'columnOf', table: ref } });
        continue;
      }
      if (u === 'ADD') {
        this.i++;
        if (this.at('COLUMN')) this.i++;
        if (this.atP('(')) {
          this.parseColumnDefs(c, ref);
          continue;
        }
        if (TABLE_CONSTRAINT_STARTS.has(this.u())) { this.skipColumnDefRest(c, ref); continue; }
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'columnName' } });
        const nt = this.peek();
        if (isNameTok(nt)) {
          this.i++;
          this.mark(c, 'ddl', nt!.end, { ddl: { what: 'dataType' } });
          this.readType();
        }
        continue;
      }
      if (this.atP('(')) { this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnOf', table: ref } }); this.skipParens(); continue; }
      this.i++;
    }
  }

  parseDropLike(c: Scope): void {
    this.i++;
    const obj = this.u();
    if (!obj) { this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'ANY' } }); return; }
    this.i++;
    if (obj === 'MATERIALIZED' || obj === 'PACKAGE' || obj === 'TYPE') { if (this.at('VIEW') || this.at('BODY')) this.i++; }
    if (this.at('IF') && this.at('EXISTS', 1)) this.i += 2;
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: obj } });
    while (!this.eof() && !this.atP(';')) {
      if (this.isTsqlStmtStart(this.t[this.i], this.i)) return;
      if (this.atP(',')) { this.i++; this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: obj } }); continue; }
      this.i++;
    }
  }

  // ------------------------------------------------------------ PostgreSQL

  /** PostgreSQL-only statement forms; returns false to fall back to the generic statement parser. */
  parsePgStatement(c: Scope, u: string): boolean {
    const t = this.t[this.i];
    switch (u) {
      case 'DO': {
        // DO [LANGUAGE x] $ … $: the body is a string; nothing to resolve
        this.mark(c, 'unknown', t.end);
        while (!this.eof() && !this.atP(';')) this.i++;
        return true;
      }
      case 'TABLE': {
        // TABLE name ≡ SELECT * FROM name
        const s = this.mkScope('select', c, null, t.start);
        s.hasFrom = true;
        this.mark(s, 'from', t.end);
        this.i++;
        if (this.at('ONLY')) this.i++;
        this.parseTableSource(s, false);
        this.parseQueryClauses(s);
        this.endScope(s);
        return true;
      }
      case 'EXPLAIN': {
        this.i++;
        while (this.at('ANALYZE') || this.at('ANALYSE') || this.at('VERBOSE')) this.i++;
        if (this.atP('(')) this.skipParens();
        this.mark(c, 'unknown', this.prevEnd(), { statementStart: true });
        if (!this.eof() && !this.atP(';')) this.parseStatement(c);
        return true;
      }
      case 'TRUNCATE': {
        this.i++;
        if (this.at('TABLE')) this.i++;
        if (this.at('ONLY')) this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
        while (!this.eof() && !this.atP(';')) {
          if (this.atP(',')) { this.i++; this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } }); continue; }
          this.i++;
        }
        return true;
      }
      case 'REFRESH': {
        // REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]
        this.i++;
        while (this.at('MATERIALIZED') || this.at('VIEW') || this.at('CONCURRENTLY')) this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'MATERIALIZED' } });
        while (!this.eof() && !this.atP(';')) this.i++;
        return true;
      }
      case 'COMMENT': {
        // COMMENT ON TABLE|VIEW|COLUMN|FUNCTION|… name IS '…'
        if (!this.at('ON', 1)) return false;
        this.i += 2;
        let obj = this.u();
        if (obj === 'MATERIALIZED') { this.i++; obj = 'MATERIALIZED'; }
        if (!obj) return true;
        this.i++;
        if (obj === 'COLUMN') {
          this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
          const parts = this.parseName();
          if (parts.length >= 2) {
            const tparts = parts.slice(0, -1);
            const ref: TableRef = { kind: 'table', parts: tparts, alias: null, aliasRange: null, nameRange: [tparts[0].range[0], tparts[tparts.length - 1].range[1]], range: [tparts[0].range[0], tparts[tparts.length - 1].range[1]] };
            this.mark(c, 'ddl', parts[parts.length - 1].range[0], { ddl: { what: 'columnOf', table: ref } });
          }
        } else {
          if (obj === 'VIEW') obj = 'VIEW';
          this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: obj } });
          this.parseName();
        }
        while (!this.eof() && !this.atP(';')) this.i++;
        return true;
      }
      case 'COPY': {
        // COPY table [(cols)] FROM|TO … / COPY (query) TO …
        this.i++;
        if (this.atP('(')) {
          this.i++;
          this.parseQuery(c, 'select', null);
          if (this.atP(')')) this.i++;
        } else {
          this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
          const parts = this.parseName();
          if (parts.length && this.atP('(')) {
            const ref: TableRef = { kind: 'table', parts, alias: null, aliasRange: null, nameRange: [parts[0].range[0], parts[parts.length - 1].range[1]], range: [parts[0].range[0], parts[parts.length - 1].range[1]] };
            this.mark(c, 'ddl', this.t[this.i].end, { ddl: { what: 'columnOf', table: ref } });
            this.skipParens();
          }
        }
        this.mark(c, 'unknown', this.prevEnd());
        while (!this.eof() && !this.atP(';')) this.i++;
        return true;
      }
      default:
        return false;
    }
  }

  /** CREATE [OR REPLACE] FUNCTION|PROCEDURE name([mode] [name] type [DEFAULT expr], …) [RETURNS …] attributes AS body. */
  parsePgRoutine(c: Scope): void {
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
    this.parseName();
    const b = this.mkScope('plsqlBlock', c, null, this.curStart());
    if (this.atP('(')) {
      this.i++;
      while (!this.eof() && !this.atP(')')) {
        let direction = 'in';
        const mode = this.u();
        if (mode === 'IN' || mode === 'OUT' || mode === 'INOUT' || mode === 'VARIADIC') {
          this.i++;
          direction = mode === 'OUT' ? 'out' : mode === 'INOUT' ? 'inout' : 'in';
          if (mode === 'IN' && this.at('OUT')) { this.i++; direction = 'inout'; }
        }
        // "name type" or just "type": a name is followed by another word
        const nt = this.peek();
        if (isNameTok(nt) && isNameTok(this.peek(1)) && !this.at('DEFAULT', 1)) {
          this.i++;
          b.localVars.set(this.varKey(namePart(nt!).text), { name: namePart(nt!).text, kind: 'param', type: '', range: [nt!.start, nt!.end], direction });
        }
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'dataType' } });
        const type = this.readType();
        if (nt && b.localVars.get(this.varKey(namePart(nt).text))) b.localVars.get(this.varKey(namePart(nt).text))!.type = type;
        while (!this.eof() && !this.atP(',') && !this.atP(')')) { if (this.atP('(')) this.skipParens(); else this.i++; }
        if (this.atP(',')) { this.i++; continue; }
      }
      if (this.atP(')')) this.i++;
    }
    while (!this.eof() && !this.atP(';')) {
      if (this.at('RETURNS')) {
        this.i++;
        if (this.at('TABLE') && this.atP('(', 1)) { this.i++; this.parseColumnDefs(c); continue; }
        if (this.at('SETOF')) this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'dataType' } });
        this.readType();
        continue;
      }
      if (this.at('BEGIN') && this.at('ATOMIC', 1)) {
        // SQL-standard body: statements over the parameters
        this.i += 2;
        this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
        this.parseStatementList(b, wordSet('END'));
        if (this.at('END')) this.i++;
        continue;
      }
      if (this.at('RETURN') && !this.atP(';', 1)) {
        this.i++;
        this.mark(b, 'expr', this.prevEnd());
        this.scanExpr(b, () => false);
        continue;
      }
      if (this.atP('(')) this.skipParens(); else this.i++;
    }
    this.endScope(b);
  }

  /** CREATE [OR REPLACE] [CONSTRAINT] TRIGGER name BEFORE|AFTER|INSTEAD OF events ON table … EXECUTE FUNCTION f(). */
  parsePgTrigger(c: Scope): void {
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
    this.parseName();
    let table: TableRef | null = null;
    while (!this.eof() && !this.atP(';')) {
      if (this.at('ON')) {
        this.i++;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
        const parts = this.parseName();
        if (parts.length) table = { kind: 'table', parts, alias: null, aliasRange: null, nameRange: [parts[0].range[0], parts[parts.length - 1].range[1]], range: [parts[0].range[0], parts[parts.length - 1].range[1]] };
        continue;
      }
      if (this.at('OF') && table === null) {
        // UPDATE OF col, … (columns of the table that follows: not known yet)
        this.i++;
        continue;
      }
      if (this.at('WHEN') && this.atP('(', 1) && table) {
        const w = this.mkScope('select', c, null, this.t[this.i].start);
        for (const nm of ['NEW', 'OLD']) w.localVars.set(nm, { name: nm.toLowerCase(), kind: 'record', type: 'ROW', range: table.parts[0].range, rowtypeOf: table.parts });
        this.i += 2;
        this.mark(w, 'where', this.prevEnd());
        this.scanExpr(w, () => false);
        if (this.atP(')')) this.i++;
        this.endScope(w);
        continue;
      }
      if (this.at('EXECUTE') && (this.at('FUNCTION', 1) || this.at('PROCEDURE', 1))) {
        this.i += 2;
        this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'FUNCTION' } });
        this.parseName();
        continue;
      }
      if (this.atP('(')) this.skipParens(); else this.i++;
    }
  }

  // ------------------------------------------------------------ PL/SQL

  parseBlock(c: Scope): Scope {
    const b = this.mkScope('plsqlBlock', c, null, this.curStart());
    if (this.at('DECLARE')) {
      this.i++;
      this.mark(b, 'declare', this.prevEnd());
      this.parseDecls(b);
    }
    this.parseBlockBody(b);
    this.endScope(b);
    return b;
  }

  /** BEGIN stmts [EXCEPTION WHEN .. THEN stmts] END [label]; */
  parseBlockBody(b: Scope): void {
    if (!this.at('BEGIN')) return;
    this.i++;
    this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
    this.parseStatementList(b, wordSet('END EXCEPTION'));
    if (this.at('EXCEPTION')) {
      this.i++;
      while (this.at('WHEN')) {
        this.i++;
        while (!this.eof() && !this.at('THEN')) this.i++;
        if (this.at('THEN')) this.i++;
        this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
        this.parseStatementList(b, wordSet('WHEN END'));
      }
    }
    if (this.at('END')) {
      this.i++;
      if (this.peek()?.kind === 'ident' || this.peek()?.kind === 'quotedIdent') this.i++;
      if (this.atP(';')) this.i++;
    }
  }

  parseDecls(b: Scope): void {
    while (!this.eof() && !this.at('BEGIN') && !this.at('END')) {
      const t = this.t[this.i];
      if (t.kind === 'punct' && t.text === ';') {
        this.i++;
        this.mark(b, 'declare', t.end);
        continue;
      }
      const u = this.u();
      if (u === 'PROCEDURE' || u === 'FUNCTION') { this.parseSubprogram(b); continue; }
      if (u === 'CURSOR') {
        this.i++;
        const nt = this.peek();
        if (!isNameTok(nt)) continue;
        this.i++;
        const v: VarDef = { name: namePart(nt!).text, kind: 'cursor', type: 'CURSOR', range: [nt!.start, nt!.end] };
        if (this.atP('(')) this.skipParens();
        if (this.at('RETURN')) { this.i++; this.readType(); }
        if (this.at('IS')) {
          this.i++;
          v.query = this.parseQuery(b, 'select', null);
        }
        b.localVars.set(this.varKey(v.name), v);
        while (!this.eof() && !this.atP(';') && !this.at('BEGIN')) this.i++;
        continue;
      }
      if (u === 'TYPE' || u === 'SUBTYPE' || u === 'PRAGMA') {
        while (!this.eof() && !this.atP(';')) { if (this.atP('(')) this.skipParens(); else this.i++; }
        continue;
      }
      if (isNameTok(t)) {
        this.i++;
        this.mark(b, 'declare', t.end, { expectType: true });
        const v: VarDef = { name: namePart(t).text, kind: 'var', type: '', range: [t.start, t.end] };
        if (this.at('EXCEPTION')) { this.i++; v.kind = 'exception'; v.type = 'EXCEPTION'; }
        else {
          if (this.at('CONSTANT')) this.i++;
          const a = this.i;
          const parts = this.parseName();
          if (this.atOp(ORACLE_ATTR_ROWTYPE)) { v.rowtypeOf = parts; this.i++; v.kind = 'record'; }
          else if (this.atOp(ORACLE_ATTR_TYPE)) { v.typeOf = parts; this.i++; }
          else {
            while (['PRECISION', 'VARYING', 'WITH', 'LOCAL', 'TIME', 'ZONE', 'DAY', 'YEAR', 'MONTH', 'TO', 'SECOND'].includes(this.u())) this.i++;
            if (this.atP('(')) this.skipParens();
          }
          v.type = this.t.slice(a, this.i).map((x) => x.text).join('');
          if (this.at('NOT') && this.at('NULL', 1)) this.i += 2;
          if (this.atOp(':=') || this.at('DEFAULT')) {
            this.i++;
            this.mark(b, 'expr', this.prevEnd());
            this.scanExpr(b, () => false);
          }
        }
        b.localVars.set(this.varKey(v.name), v);
        while (!this.eof() && !this.atP(';') && !this.at('BEGIN')) this.i++;
        continue;
      }
      this.i++;
    }
  }

  /** Parameters `(name [IN|OUT|IN OUT] [NOCOPY] type [:= default], ...)` into the scope. */
  parsePlsqlParams(b: Scope): void {
    if (!this.atP('(')) return;
    this.i++;
    while (!this.eof() && !this.atP(')')) {
      const t = this.peek()!;
      if (isNameTok(t)) {
        this.i++;
        let direction = 'in';
        if (this.at('IN')) { this.i++; if (this.at('OUT')) { this.i++; direction = 'inout'; } }
        else if (this.at('OUT')) { this.i++; direction = 'out'; }
        if (this.at('NOCOPY')) this.i++;
        this.mark(b, 'declare', this.prevEnd(), { expectType: true });
        const a = this.i;
        const parts = this.parseName();
        const v: VarDef = { name: namePart(t).text, kind: 'param', type: '', range: [t.start, t.end], direction };
        if (this.atOp(ORACLE_ATTR_ROWTYPE)) { v.rowtypeOf = parts; v.kind = 'param'; this.i++; }
        else if (this.atOp(ORACLE_ATTR_TYPE)) { v.typeOf = parts; this.i++; }
        v.type = this.t.slice(a, this.i).map((x) => x.text).join('');
        b.localVars.set(this.varKey(v.name), v);
      }
      while (!this.eof() && !this.atP(',') && !this.atP(')')) { if (this.atP('(')) this.skipParens(); else this.i++; }
      if (this.atP(',')) this.i++;
    }
    if (this.atP(')')) this.i++;
  }

  parseSubprogram(parent: Scope): void {
    this.i++;
    const sub = this.mkScope('plsqlBlock', parent, null, this.curStart());
    this.parseName();
    this.parsePlsqlParams(sub);
    while (!this.eof() && !this.at('IS') && !this.at('AS') && !this.atP(';')) this.i++;
    if (this.atP(';')) { this.i++; this.endScope(sub); return; }
    this.i++;
    if (this.at('EXTERNAL') || this.at('LANGUAGE')) { while (!this.eof() && !this.atP(';')) this.i++; this.endScope(sub); return; }
    this.parseDecls(sub);
    this.parseBlockBody(sub);
    this.endScope(sub);
  }

  parsePlsqlUnit(c: Scope, obj: string): void {
    if (obj === 'PACKAGE' || obj === 'TYPE') {
      const body = this.at('BODY');
      if (body) this.i++;
      this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
      this.parseName();
      const b = this.mkScope('plsqlBlock', c, null, this.curStart());
      while (!this.eof() && !this.at('IS') && !this.at('AS')) this.i++;
      if (!this.eof()) this.i++;
      if (obj === 'TYPE' && !body) { this.scanExpr(b, () => false); this.endScope(b); return; }
      this.parseDecls(b);
      if (this.at('BEGIN')) this.parseBlockBody(b);
      else if (this.at('END')) { this.i++; if (isNameTok(this.peek())) this.i++; if (this.atP(';')) this.i++; }
      this.endScope(b);
      return;
    }
    this.mark(c, 'ddl', this.prevEnd(), { ddl: { what: 'newName' } });
    this.parseName();
    const b = this.mkScope('plsqlBlock', c, null, this.curStart());
    if (obj === 'TRIGGER') {
      let table: NamePart[] = [];
      while (!this.eof() && !this.at('BEGIN') && !this.at('DECLARE') && !this.at('COMPOUND')) {
        if (this.at('ON')) {
          this.i++;
          this.mark(b, 'ddl', this.prevEnd(), { ddl: { what: 'objectName', objectType: 'TABLE' } });
          table = this.parseName();
          continue;
        }
        if (this.at('WHEN') && this.atP('(', 1)) { this.i++; this.mark(b, 'where', this.t[this.i].end); this.skipParens(); continue; }
        this.i++;
      }
      if (table.length) {
        for (const nm of ['NEW', 'OLD']) b.localVars.set(nm, { name: ':' + nm.toLowerCase(), kind: 'record', type: 'ROW', range: table[0].range, rowtypeOf: table });
      }
      if (this.at('DECLARE')) { this.i++; this.parseDecls(b); }
      this.parseBlockBody(b);
      this.endScope(b);
      return;
    }
    this.parsePlsqlParams(b);
    while (!this.eof() && !this.at('IS') && !this.at('AS')) this.i++;
    if (!this.eof()) this.i++;
    if (this.at('EXTERNAL') || this.at('LANGUAGE')) { while (!this.eof() && !this.atP(';')) this.i++; this.endScope(b); return; }
    this.mark(b, 'declare', this.prevEnd());
    this.parseDecls(b);
    this.parseBlockBody(b);
    this.endScope(b);
  }

  parsePlsqlIf(b: Scope): void {
    const kw = this.t[this.i];
    this.i++;
    this.mark(b, 'expr', kw.end);
    this.scanExpr(b, () => false);
    for (;;) {
      if (this.at('THEN')) {
        this.i++;
        this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
        this.parseStatementList(b, wordSet('ELSIF ELSE END'));
      }
      if (this.at('ELSIF')) {
        this.i++;
        this.mark(b, 'expr', this.prevEnd());
        this.scanExpr(b, () => false);
        continue;
      }
      if (this.at('ELSE')) {
        this.i++;
        this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
        this.parseStatementList(b, wordSet('END'));
      }
      break;
    }
    if (this.at('END')) { this.i++; if (this.at('IF')) this.i++; }
    if (this.atP(';')) this.i++;
  }

  parsePlsqlLoop(b: Scope): void {
    if (this.at('WHILE')) {
      this.i++;
      this.mark(b, 'expr', this.prevEnd());
      this.scanExpr(b, () => false);
    }
    this.loopBody(b);
  }

  loopBody(b: Scope): void {
    if (!this.at('LOOP')) return;
    this.i++;
    this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
    this.parseStatementList(b, wordSet('END'));
    if (this.at('END')) { this.i++; if (this.at('LOOP')) this.i++; if (this.peek()?.kind === 'ident') this.i++; }
    if (this.atP(';')) this.i++;
  }

  parsePlsqlFor(b: Scope): void {
    this.i++;
    const rt = this.peek();
    if (!isNameTok(rt)) return;
    this.i++;
    const v: VarDef = { name: namePart(rt!).text, kind: 'record', type: 'RECORD', range: [rt!.start, rt!.end] };
    if (this.at('IN')) this.i++;
    if (this.at('REVERSE')) this.i++;
    if (this.atP('(') && (this.at('SELECT', 1) || this.at('WITH', 1))) {
      this.i++;
      v.query = this.parseQuery(b, 'select', null);
      if (this.atP(')')) this.i++;
    } else if (isNameTok(this.peek()) && (this.at('LOOP', 1) || this.atP('(', 1))) {
      v.recordOfCursor = namePart(this.peek()!).text;
      this.i++;
      if (this.atP('(')) this.skipParens();
    } else {
      v.kind = 'var';
      v.type = 'PLS_INTEGER';
      this.mark(b, 'expr', this.prevEnd());
      this.scanExpr(b, () => false);
    }
    // the loop variable is visible inside the loop body only, but block-level visibility is good enough
    b.localVars.set(this.varKey(v.name), v);
    this.loopBody(b);
  }

  parsePlsqlCase(b: Scope): void {
    this.i++;
    this.mark(b, 'expr', this.prevEnd());
    this.scanExpr(b, (k) => this.t[k].upper === 'WHEN');
    while (this.at('WHEN') || this.at('ELSE')) {
      const isElse = this.at('ELSE');
      this.i++;
      if (!isElse) {
        this.mark(b, 'expr', this.prevEnd());
        this.scanExpr(b, () => false);
        if (this.at('THEN')) this.i++;
      }
      this.mark(b, 'unknown', this.prevEnd(), { statementStart: true });
      this.parseStatementList(b, wordSet('WHEN ELSE END'));
    }
    if (this.at('END')) { this.i++; if (this.at('CASE')) this.i++; }
    if (this.atP(';')) this.i++;
  }
}

/**
 * Build the structure model of one statement. `tokens` are the statement's significant tokens
 * (no comments); `start`/`end` its document offsets.
 */
export function buildModel(tokens: Token[], spec: DialectSpec, start: number, end: number): StatementModel {
  const p = new Parser(tokens, spec, start, end);
  try {
    p.parseStatementList(p.m.root, new Set());
  } catch {
    // structure parser must never break completion; keep what we have
  }
  for (const s of p.m.scopes) s.markers.sort((a, b) => a.pos - b.pos);
  p.m.scopes.sort((a, b) => a.range[0] - b.range[0] || a.id - b.id);
  return p.m;
}

/** Deepest scope whose content range contains `offset`. */
export function scopeAt(model: StatementModel, offset: number): Scope {
  let best = model.root;
  let bestDepth = 0;
  for (const s of model.scopes) {
    if (s.range[0] <= offset && offset <= s.range[1]) {
      let d = 0;
      for (let p = s.parent; p; p = p.parent) d++;
      if (d > bestDepth || (d === bestDepth && s.range[0] >= best.range[0])) {
        best = s;
        bestDepth = d;
      }
    }
  }
  return best;
}
