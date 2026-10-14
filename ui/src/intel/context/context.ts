// Cursor context detection (PLAN 4.5).
import type { Token } from '../types';
import type { DialectSpec } from '../dialect/spec';
import type { ClauseKind, Marker, NamePart, Scope, StatementModel, TableRef } from '../parse/statement-model';
import { namePart, scopeAt } from '../parse/partial-parser';

export interface FunctionCallContext {
  /** Dotted name of the called function/procedure. */
  parts: NamePart[];
  name: string;
  argIndex: number;
  /** Named argument being written (`p_total => |`), Oracle. */
  argName: string | null;
  /** Names of already given named arguments. */
  namedArgs: string[];
  openParen: number;
  /** T-SQL EXEC proc a, b (no parentheses). */
  exec: boolean;
}

export interface CursorContext {
  statement: StatementModel;
  scope: Scope;
  clause: ClauseKind;
  marker: Marker | null;
  qualifier: NamePart[] | null;
  /** Raw typed prefix (may start with a quote / @ / #). */
  prefix: string;
  /** Prefix without quotes, used for matching. */
  prefixText: string;
  prefixStart: number;
  prefixQuoted: '"' | '[' | '`' | null;
  /** A closing quote/bracket already follows the cursor. */
  closingQuoteAfter: boolean;
  /** Offset just after that closing quote (to replace it when the inserted name needs no quoting). */
  quoteCloseEnd: number | null;
  prevToken: Token | null;
  prevKeyword: string | null;
  inFunctionCall: FunctionCallContext | null;
  afterJoinTable: TableRef | null;
  expectsExpression: boolean;
  afterOperand: boolean;
  statementHasFrom: boolean;
  statementEndsAtCursor: boolean;
  atStatementStart: boolean;
  /** FROM/JOIN/...: a complete table source precedes the cursor (→ keyword flow). */
  afterSource: boolean;
  /** The word being typed is parsed as the alias of a table source. */
  aliasTyping: boolean;
  /** SET clause: the cursor is on the left side of `=`. */
  setLhs: boolean;
  /** Offset of the start of the qualifier chain (or prefixStart). */
  chainStart: number;
  /** Prefix token is the first token on its line. */
  firstOnLine: boolean;
  offset: number;
}

const NOT_FUNCTION_BEFORE_PAREN = new Set([
  'IN', 'EXISTS', 'VALUES', 'AS', 'OVER', 'FROM', 'JOIN', 'ON', 'WHERE', 'SELECT', 'AND', 'OR', 'NOT', 'INTO', 'TABLE',
  'WITH', 'USING', 'BY', 'THEN', 'ELSE', 'WHEN', 'CASE', 'IS', 'SET', 'RETURN', 'RETURNS', 'KEY', 'REFERENCES', 'UNIQUE',
  'CHECK', 'ALL', 'ANY', 'SOME', 'IF', 'WHILE', 'LIKE', 'BETWEEN', 'UNION', 'EXCEPT', 'INTERSECT', 'MINUS', 'APPLY',
  'PRIMARY', 'OPTION', 'PARTITION', 'PIVOT', 'UNPIVOT', 'FOR', 'DISTINCT', 'WITHIN', 'LIMIT', 'OFFSET', 'TOP',
]);
const OPERAND_KEYWORDS = new Set(['NULL', 'END', 'TRUE', 'FALSE', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'SYSDATE', 'SYSTIMESTAMP', 'ROWNUM', 'LEVEL', 'USER']);

function isName(t: Token | undefined): boolean {
  return !!t && (t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'quotedIdent');
}
function isPunct(t: Token | undefined, text: string): boolean {
  return !!t && t.kind === 'punct' && t.text === text;
}

/** Index of the last token with start < offset (−1 if none). */
function lastBefore(toks: Token[], offset: number): number {
  let lo = 0, hi = toks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toks[mid].start < offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function detectContext(model: StatementModel, offset: number, spec: DialectSpec, text: string): CursorContext {
  const toks = model.tokens;
  let k = lastBefore(toks, offset);
  let prefix = '';
  let prefixStart = offset;
  let prefixQuoted: CursorContext['prefixQuoted'] = null;
  let closingQuoteAfter = false;
  let cur: Token | null = null;
  if (k >= 0) {
    const t = toks[k];
    if (t.end >= offset && (t.kind === 'ident' || t.kind === 'keyword' || t.kind === 'quotedIdent' || t.kind === 'param')) {
      cur = t;
      prefixStart = t.start;
      prefix = text.slice(t.start, offset);
      if (t.kind === 'quotedIdent') {
        prefixQuoted = t.text[0] as '"' | '[' | '`';
        closingQuoteAfter = !t.unterminated && t.end > offset;
      }
      k--;
    }
  }
  let quoteCloseEnd: number | null = closingQuoteAfter && cur ? cur.end : null;
  if (!closingQuoteAfter && prefixQuoted) {
    const close = prefixQuoted === '[' ? ']' : prefixQuoted;
    closingQuoteAfter = text[offset] === close;
    if (closingQuoteAfter) quoteCloseEnd = offset + 1;
  }
  let prefixText = prefix;
  if (prefixQuoted) {
    prefixText = prefix.slice(1);
    const close = prefixQuoted === '[' ? ']' : prefixQuoted;
    if (prefixText.endsWith(close)) prefixText = prefixText.slice(0, -1);
  }

  // qualifier chain `a.b.|`
  let qualifier: NamePart[] | null = null;
  let chainStart = prefixStart;
  let j = k;
  if (j >= 0 && isPunct(toks[j], '.') && toks[j].end === prefixStart) {
    const parts: NamePart[] = [];
    while (j >= 0 && isPunct(toks[j], '.')) {
      const before = toks[j - 1];
      if (isName(before) || (before && before.kind === 'param')) {
        parts.unshift(namePart(before));
        chainStart = before.start;
        j -= 2;
      } else if (isPunct(before, '.') && spec.id === 'tsql') {
        parts.unshift({ text: '', quoted: false, range: [toks[j].start, toks[j].start] });
        j -= 1;
      } else break;
    }
    if (parts.length) qualifier = parts;
    else j = k;
  }
  const prevToken = j >= 0 ? toks[j] : null;

  const scope = scopeAt(model, chainStart);
  let marker: Marker | null = null;
  for (const m of scope.markers) {
    if (m.pos <= chainStart) marker = m; else break;
  }
  let clause: ClauseKind = marker ? marker.clause : 'unknown';

  // first sig token after the cursor (excluding the token being typed)
  let after: Token | null = null;
  for (let a = Math.max(0, lastBefore(toks, offset)); a < toks.length; a++) {
    if (toks[a].start >= offset && toks[a] !== cur) { after = toks[a]; break; }
  }
  const statementEndsAtCursor = !after;

  // statement start
  const firstSig = toks[0];
  let atStatementStart = !prevToken || (firstSig !== undefined && chainStart <= firstSig.start);
  if (!atStatementStart && marker?.data?.statementStart && (!prevToken || prevToken.end <= marker.pos)) atStatementStart = true;
  if (!atStatementStart && prevToken && (isPunct(prevToken, ';'))) atStatementStart = true;
  if (atStatementStart && !qualifier) clause = 'unknown';

  // operand / expression state
  let afterOperand = false;
  let expectsExpression = false;
  if (prevToken) {
    const pk = prevToken.kind;
    if (pk === 'ident' || pk === 'quotedIdent' || pk === 'number' || pk === 'string' || pk === 'param' || isPunct(prevToken, ')')) afterOperand = true;
    else if (pk === 'keyword' && OPERAND_KEYWORDS.has(prevToken.upper)) afterOperand = true;
    else expectsExpression = true;
    if (marker && prevToken.end <= marker.pos) { afterOperand = false; expectsExpression = true; }
  }

  // prev keyword
  let prevKeyword: string | null = null;
  for (let b = j; b >= 0; b--) {
    if (toks[b].kind === 'keyword') { prevKeyword = toks[b].upper; break; }
  }

  // FROM-like contexts: complete source before the cursor?
  let afterSource = false;
  let aliasTyping = false;
  const tableClause = clause === 'from' || clause === 'join' || clause === 'update' || clause === 'delete' || clause === 'into' || clause === 'using';
  if (tableClause && marker && !qualifier) {
    for (const r of scope.sources) {
      if (r.range[0] >= marker.pos && r.range[1] <= prefixStart && r.range[1] > r.range[0]) afterSource = true;
      if (r.aliasRange && r.aliasRange[0] === prefixStart) aliasTyping = true;
    }
    if (scope.targetTable && (clause === 'into' || clause === 'update' || clause === 'delete')) {
      const r = scope.targetTable;
      if (r.range[0] >= marker.pos && r.range[1] <= prefixStart) afterSource = true;
      if (r.aliasRange && r.aliasRange[0] === prefixStart) aliasTyping = true;
    }
  }

  // SET lhs/rhs
  let setLhs = false;
  if (clause === 'set' && marker) {
    setLhs = true;
    let depth = 0;
    for (let b = 0; b < toks.length && toks[b].start < chainStart; b++) {
      const t = toks[b];
      if (t.start < marker.pos) continue;
      if (isPunct(t, '(')) depth++;
      else if (isPunct(t, ')')) depth--;
      else if (depth === 0 && isPunct(t, ',')) setLhs = true;
      else if (depth === 0 && t.kind === 'op' && (t.text === '=' || t.text === '+=' || t.text === '-=')) setLhs = false;
    }
  }

  // function call / EXEC args
  let inFunctionCall: FunctionCallContext | null = null;
  if (clause !== 'insertColumns' && clause !== 'cteColumns' && clause !== 'ddl' && clause !== 'declare') {
    inFunctionCall = findCall(toks, j, chainStart, spec);
  }
  if (!inFunctionCall && clause === 'execArgs' && marker?.data?.proc) {
    let commas = 0, depth = 0;
    const named: string[] = [];
    for (const t of toks) {
      if (t.start < marker.pos || t.start >= chainStart) continue;
      if (isPunct(t, '(')) depth++;
      else if (isPunct(t, ')')) depth--;
      else if (depth === 0 && isPunct(t, ',')) commas++;
      else if (t.kind === 'param') named.push(t.text);
    }
    const parts = marker.data.proc;
    inFunctionCall = { parts, name: parts[parts.length - 1].text, argIndex: commas, argName: null, namedArgs: named, openParen: marker.pos, exec: true };
  }

  const firstOnLine = cur ? isFirstOnLine(text, cur.start) : isFirstOnLine(text, offset);

  return {
    statement: model, scope, clause, marker, qualifier, prefix, prefixText, prefixStart, prefixQuoted, closingQuoteAfter, quoteCloseEnd,
    prevToken, prevKeyword, inFunctionCall,
    afterJoinTable: clause === 'on' ? marker?.data?.joinRef ?? null : null,
    expectsExpression, afterOperand, statementHasFrom: scope.hasFrom, statementEndsAtCursor, atStatementStart,
    afterSource, aliasTyping, setLhs, chainStart, firstOnLine, offset,
  };
}

function isFirstOnLine(text: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

/** Walk back from token index `j` to the innermost unclosed '(' preceded by a function name. */
export function findCall(toks: Token[], j: number, limit: number, spec: DialectSpec): FunctionCallContext | null {
  let depth = 0;
  let commas = 0;
  let argName: string | null = null;
  let sawArrowSinceComma = false;
  const named: string[] = [];
  for (let b = j; b >= 0; b--) {
    const t = toks[b];
    if (t.start >= limit) continue;
    if (t.kind === 'punct') {
      if (t.text === ')') { depth++; continue; }
      if (t.text === '(') {
        if (depth > 0) { depth--; continue; }
        // unmatched '(' → call?
        const nameTok = toks[b - 1];
        if (!nameTok) return null;
        if (!(nameTok.kind === 'ident' || nameTok.kind === 'quotedIdent' || (nameTok.kind === 'keyword' && (spec.functionMap.has(nameTok.upper) || ['LEFT', 'RIGHT', 'CONVERT', 'COALESCE', 'NULLIF', 'TRY_CONVERT', 'REPLACE'].includes(nameTok.upper))))) return null;
        if (nameTok.kind === 'keyword' && NOT_FUNCTION_BEFORE_PAREN.has(nameTok.upper)) return null;
        if (nameTok.kind === 'ident' && NOT_FUNCTION_BEFORE_PAREN.has(nameTok.upper)) return null;
        const parts: NamePart[] = [namePart(nameTok)];
        let c = b - 2;
        while (c >= 1 && isPunct(toks[c], '.') && isName(toks[c - 1])) { parts.unshift(namePart(toks[c - 1])); c -= 2; }
        if (sawArrowSinceComma && argName === null) argName = null;
        return { parts, name: parts[parts.length - 1].text, argIndex: commas, argName, namedArgs: named, openParen: t.end, exec: false };
      }
      if (t.text === ';') return null;
      if (t.text === ',' && depth === 0) { commas++; sawArrowSinceComma = false; continue; }
      continue;
    }
    if (depth === 0 && t.kind === 'op' && t.text === '=>') {
      const nm = toks[b - 1];
      if (nm && isName(nm)) {
        if (commas === 0 && !sawArrowSinceComma) argName = namePart(nm).text;
        named.push(namePart(nm).text);
        sawArrowSinceComma = true;
      }
    }
  }
  return null;
}
