// Postfix templates (PLAN-M1.5 A4, WP-H): typing `Customers.sel` at the start of a statement and accepting the
// suggestion replaces the whole chain with `SELECT * FROM Customers`. Offered only when the qualifier resolves to
// a table or view of the catalog. Wired into the completer through the `extraSources` hook.
import type { CompletionItem } from '../types';
import type { CompleteEnv, ExtraCompletionSource } from './completer';
import type { CursorContext } from '../context/context';
import { matchScore, sortTextFor } from './ranker';
import { kwCase, needsQuoting, quoteIdent, snippetEscape } from './format';

export interface PostfixTemplate {
  /** Typed after the dot. */
  key: string;
  doc: string;
  /** `name` is the table text as typed; `cols` the formatted column names (insertable first). */
  body(name: string, cols: string[], kw: (s: string) => string): string;
  snippet: boolean;
}

export const POSTFIX_TEMPLATES: PostfixTemplate[] = [
  { key: 'sel', doc: 'SELECT * FROM table', snippet: true, body: (n, _c, k) => `${k('SELECT')} * ${k('FROM')} ${n}$0` },
  {
    key: 'selw', doc: 'SELECT * FROM table WHERE …', snippet: true,
    body: (n, c, k) => `${k('SELECT')} * ${k('FROM')} ${n} ${k('WHERE')} \${1:${c[0] ?? 'condition'}} = \${2:value}$0`,
  },
  { key: 'count', doc: 'SELECT COUNT(*) FROM table', snippet: true, body: (n, _c, k) => `${k('SELECT')} ${k('COUNT')}(*) ${k('FROM')} ${n}$0` },
  {
    key: 'ins', doc: 'INSERT INTO table (columns) VALUES (…)', snippet: true,
    body: (n, c, k) => c.length
      ? `${k('INSERT INTO')} ${n} (${c.join(', ')})\n${k('VALUES')} (${c.map((x, i) => `\${${i + 1}:${x}}`).join(', ')})$0`
      : `${k('INSERT INTO')} ${n} (\${1:columns})\n${k('VALUES')} (\${2:values})$0`,
  },
  {
    key: 'upd', doc: 'UPDATE table SET … WHERE …', snippet: true,
    body: (n, c, k) => `${k('UPDATE')} ${n}\n${k('SET')} \${1:${c[0] ?? 'column'}} = \${2:value}\n${k('WHERE')} \${3:condition}$0`,
  },
  { key: 'del', doc: 'DELETE FROM table WHERE …', snippet: true, body: (n, _c, k) => `${k('DELETE FROM')} ${n}\n${k('WHERE')} \${1:condition}$0` },
];

/** The chain `a.b.prefix` starts the statement: nothing but the qualifier precedes it. */
function chainStartsStatement(c: CursorContext): boolean {
  const first = c.statement.tokens[0];
  return !first || first.start >= c.chainStart;
}

export const postfixSource: ExtraCompletionSource = (c: CursorContext, env: CompleteEnv): CompletionItem[] | null => {
  if (!c.qualifier || !c.qualifier.length || !chainStartsStatement(c)) return null;
  const target = env.binder.resolveQualifier(c.qualifier, c.scope);
  if (!target || target.kind !== 'object' || !target.entry.isTabular) return null;
  const entry = target.entry;
  const last = c.qualifier[c.qualifier.length - 1];
  const nameText = env.text.slice(c.chainStart, last.range[1]);
  const cols = entry.columns().filter((col) => !col.identity && !col.computed && !col.hidden).map((col) => snippetEscape(needsQuoting(col.name, env.spec) ? quoteIdent(col.name, env.spec.quote[0]) : col.name));
  const kw = (s: string) => kwCase(s, env.opts);
  const out: CompletionItem[] = [];
  for (const t of POSTFIX_TEMPLATES) {
    const ms = matchScore(c.prefixText, t.key);
    if (c.prefixText && ms < 0) continue;
    const score = 9500 + ms;
    out.push({
      label: t.key, kind: 'snippet', detail: `postfix · ${t.doc}`,
      documentation: '```sql\n' + t.body(nameText, cols, kw).replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d/g, '') + '\n```',
      insertText: t.body(snippetEscape(nameText), cols, kw), isSnippet: t.snippet,
      // Monaco filters on the replaced text (`Customers.se`), so the filter text is the whole chain
      sortText: sortTextFor(score), filterText: env.text.slice(c.chainStart, c.prefixStart) + t.key, score,
      range: [c.chainStart, c.offset], usageKey: 'postfix:' + t.key,
    });
  }
  return out;
};
