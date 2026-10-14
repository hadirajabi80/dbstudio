// Line tokenizer for syntax highlighting, driven by the intel lexer (so highlighting and parsing agree).
// Pure: no Monaco imports (unit-tested in node).
import { lexLine, type DialectSpec, type LexState } from '../intel';

export interface ScopedToken { startIndex: number; scopes: string }

const PARAM_GLOBAL = /^@@/;

export function tokenizeLine(line: string, spec: DialectSpec, state: LexState): { tokens: ScopedToken[]; endState: LexState } {
  const { tokens, endState } = lexLine(line, spec, state);
  const out: ScopedToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let scopes: string;
    switch (t.kind) {
      case 'keyword':
        scopes = spec.dataTypeSet.has(t.upper) ? 'type' : 'keyword';
        if (scopes === 'keyword' && tokens[i + 1]?.text === '(' && spec.functionMap.has(t.upper)) scopes = 'predefined';
        break;
      case 'ident': {
        const prev = tokens[i - 1];
        const afterDot = prev && prev.text === '.' && prev.start + 1 === t.start;
        if (!afterDot && spec.dataTypeSet.has(t.upper) && tokens[i + 1]?.text !== '.') scopes = 'type';
        else if (!afterDot && tokens[i + 1]?.text === '(' && spec.functionMap.has(t.upper)) scopes = 'predefined';
        else if (!afterDot && spec.contextualKeywords.has(t.upper) && tokens[i + 1]?.text !== '.' && tokens[i + 1]?.text !== '(') scopes = 'keyword.contextual';
        else scopes = 'identifier';
        break;
      }
      case 'quotedIdent': scopes = 'identifier.quote'; break;
      case 'string': scopes = 'string'; break;
      case 'number': scopes = 'number'; break;
      case 'comment': scopes = 'comment'; break;
      case 'param': scopes = PARAM_GLOBAL.test(t.text) ? 'predefined' : 'variable'; break;
      case 'op': scopes = 'operator'; break;
      case 'punct': scopes = t.text === '(' || t.text === ')' ? 'delimiter.parenthesis' : 'delimiter'; break;
      case 'batchSep': scopes = 'keyword.batch'; break;
      default: scopes = '';
    }
    out.push({ startIndex: t.start, scopes });
  }
  if (out.length === 0 || out[0].startIndex > 0) out.unshift({ startIndex: 0, scopes: '' });
  return { tokens: out, endState };
}
