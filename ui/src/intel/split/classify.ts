// Statement classification for the destructive-run guard and history labels.
import type { StatementBaseKind, StatementKind, Token } from '../types';
import type { DialectSpec } from '../dialect/spec';

function sigTokens(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'comment' && t.kind !== 'eof' && t.kind !== 'ws');
}

/** True when the token list has a WHERE keyword at paren depth 0. */
function hasTopLevelWhere(toks: Token[], from: number): boolean {
  let depth = 0;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind === 'punct') {
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
    } else if (depth === 0 && t.upper === 'WHERE' && (t.kind === 'keyword' || t.kind === 'ident')) return true;
  }
  return false;
}

/** Skip a WITH list: returns the index of the main statement keyword after the CTEs. */
function afterWith(toks: Token[], i: number): number {
  let depth = 0;
  for (let j = i + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t.kind === 'punct') {
      if (t.text === '(') depth++;
      else if (t.text === ')') depth--;
    } else if (depth === 0 && (t.kind === 'keyword' || t.kind === 'ident')) {
      if (t.upper === 'SELECT' || t.upper === 'INSERT' || t.upper === 'UPDATE' || t.upper === 'DELETE' || t.upper === 'MERGE' || t.upper === 'REPLACE') return j;
    }
  }
  return -1;
}

export function classifyTokens(tokens: Token[], spec: DialectSpec): StatementKind {
  const toks = sigTokens(tokens);
  if (toks.length === 0) return 'empty';
  let i = 0;
  if (toks[0].upper === 'WITH') {
    const j = afterWith(toks, 0);
    if (j < 0) return 'select';
    i = j;
  }
  const u = toks[i].upper;
  const n1 = toks[i + 1]?.upper ?? '';
  const destructive = (k: StatementBaseKind): StatementKind => `${k}:destructive`;
  switch (u) {
    case 'SELECT': case 'VALUES': case 'TABLE': return 'select';
    case 'INSERT': return 'insert';
    case 'REPLACE': return spec.id === 'sqlite' ? 'insert' : 'other';
    case 'UPDATE': return hasTopLevelWhere(toks, i) ? 'update' : destructive('update');
    case 'DELETE': return hasTopLevelWhere(toks, i) ? 'delete' : destructive('delete');
    case 'MERGE': return 'merge';
    case 'TRUNCATE': return destructive('truncate');
    case 'DROP': return destructive('drop');
    case 'CREATE': return 'create';
    case 'ALTER': return 'alter';
    case 'RENAME': case 'COMMENT': case 'PURGE': case 'FLASHBACK': case 'ANALYZE': case 'VACUUM': case 'REINDEX':
    case 'ATTACH': case 'DETACH': return 'other';
    case 'EXEC': case 'EXECUTE': case 'CALL': return 'exec';
    case 'DECLARE': return spec.id === 'plsql' ? 'block' : 'declare';
    case 'BEGIN':
      if (spec.id === 'plsql') return 'block';
      if (spec.id === 'sqlite') return 'tx';
      return n1 === 'TRAN' || n1 === 'TRANSACTION' || n1 === 'DISTRIBUTED' ? 'tx' : 'block';
    case 'COMMIT': case 'ROLLBACK': case 'SAVEPOINT': case 'SAVE': case 'RELEASE': return 'tx';
    case 'END': return spec.id === 'sqlite' ? 'tx' : 'other';
    case 'SET': return 'set';
    case 'USE': return 'use';
    case 'GRANT': case 'REVOKE': case 'DENY': return 'grant';
    case 'PRAGMA': return 'pragma';
    case 'EXPLAIN': return 'explain';
    case 'IF': case 'WHILE': return 'block';
    default: return 'other';
  }
}

export function isDestructive(kind: StatementKind): boolean {
  return kind.endsWith(':destructive');
}
