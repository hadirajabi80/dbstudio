// Parameter hint (PLAN-M1.5 A2/WP-H): "3 parameters · Ctrl+Alt+P to edit" after the first line of the statement at
// the cursor when it contains bind parameters. Pure: works on intel tokens.
import type { Dialect, Token } from '../intel/types';

/**
 * Bind parameters of tokens [a, b): T-SQL `@x` not declared in the batch (no `@@globals`, no routine bodies),
 * Oracle `:x` (not `:new`/`:old`, not `&substitution`), SQLite `?`, `?1`, `:x`, `@x`, `$x`. Names are unique
 * except anonymous `?`, which counts once per occurrence.
 */
export function statementParams(tokens: readonly Token[], a: number, b: number, dialect: Dialect, batch?: readonly Token[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const declared = new Set<string>();
  if (dialect === 'tsql') {
    const scope = batch ?? tokens.slice(a, b);
    for (let i = 0; i < scope.length; i++) {
      const t = scope[i];
      if (t.kind === 'keyword' && (t.upper === 'PROC' || t.upper === 'PROCEDURE' || t.upper === 'FUNCTION' || t.upper === 'TRIGGER')) {
        const prev = scope[i - 1];
        if (prev && (prev.upper === 'CREATE' || prev.upper === 'ALTER')) return [];
      }
      if (t.kind === 'keyword' && t.upper === 'DECLARE') {
        // DECLARE @a int = 1, @b int …: every top-level `@x` right after DECLARE or a comma
        let depth = 0;
        for (let j = i + 1; j < scope.length; j++) {
          const u = scope[j];
          if (u.kind === 'punct' && u.text === '(') depth++;
          else if (u.kind === 'punct' && u.text === ')') depth--;
          else if (u.kind === 'punct' && u.text === ';') break;
          if (u.kind === 'param' && depth === 0 && (j === i + 1 || (scope[j - 1].kind === 'punct' && scope[j - 1].text === ','))) declared.add(u.upper.toUpperCase());
          if (u.kind === 'keyword' && depth === 0 && j > i + 1 && u.line !== scope[i].line && scope[j - 1].text !== ',') break;
        }
      }
    }
  }
  for (let i = a; i < b; i++) {
    const t = tokens[i];
    if (t.kind !== 'param') continue;
    const text = t.text;
    if (dialect === 'tsql' && (text.startsWith('@@') || declared.has(text.toUpperCase()))) continue;
    if (dialect === 'plsql') {
      if (!text.startsWith(':')) continue;
      const n = text.slice(1).toUpperCase();
      if (n === 'NEW' || n === 'OLD' || n === 'PARENT') continue;
    }
    if (text === '?') { out.push('?'); continue; }
    const key = text.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function paramHintText(count: number, shortcut: string): string {
  return `${count} parameter${count === 1 ? '' : 's'} · ${shortcut} to edit`;
}
