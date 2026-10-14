// Snippets and live templates (PLAN-M1.5 A4): built-ins per dialect plus user snippets from Settings.snippets.
// Surfaced through the completer (statement start, kind `snippet`, ranked below exact keyword matches), through
// Ctrl+J "Insert snippet…" (snippets only, anywhere), and as postfix templates (`Customers.sel`, intel/complete/postfix).
// Pure TypeScript: no React, Monaco or DOM.
import type { Dialect, Snippet } from '../api/types';
import type { CompletionItem, CursorContext, CompleteEnv, ExtraCompletionSource } from '../intel';
import { matchScore, sortTextFor } from '../intel';
import { BUILTIN_SNIPPETS, type SnippetDef } from './builtins';

export { BUILTIN_SNIPPETS, type SnippetDef };

/** Built-ins for a dialect overlaid with the user's snippets (a user snippet replaces a built-in with its prefix). */
export function snippetsFor(dialect: Dialect, user: readonly Snippet[] | null | undefined): SnippetDef[] {
  const applies = (s: { dialects: Dialect[] | null }) => !s.dialects || s.dialects.length === 0 || s.dialects.includes(dialect);
  const mine = (user ?? []).filter((s) => applies(s) && isValidSnippet(s)).map((s): SnippetDef => ({ ...s, builtin: false }));
  const taken = new Set(mine.map((s) => s.prefix.toLowerCase()));
  return [...mine, ...BUILTIN_SNIPPETS.filter((s) => applies(s) && !taken.has(s.prefix.toLowerCase()))];
}

export interface SnippetProblem { field: 'name' | 'prefix' | 'body'; message: string }

/** Validation used by the settings editor (and to ignore broken persisted entries). */
export function validateSnippet(s: Pick<Snippet, 'name' | 'prefix' | 'body'>, others: readonly Pick<Snippet, 'prefix' | 'dialects'>[] = []): SnippetProblem[] {
  const out: SnippetProblem[] = [];
  if (!s.name.trim()) out.push({ field: 'name', message: 'Give the snippet a name.' });
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s.prefix)) out.push({ field: 'prefix', message: 'Prefix: letters, digits, _ . - (no spaces), starting with a letter.' });
  else if (others.some((o) => o.prefix.toLowerCase() === s.prefix.toLowerCase())) out.push({ field: 'prefix', message: `Another snippet already uses "${s.prefix}".` });
  if (!s.body.trim()) out.push({ field: 'body', message: 'The body is empty.' });
  else {
    let depth = 0;
    for (let i = 0; i < s.body.length; i++) {
      const ch = s.body[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '$' && s.body[i + 1] === '{') { depth++; i++; } else if (ch === '}' && depth > 0) depth--;
    }
    if (depth > 0) out.push({ field: 'body', message: 'A ${…} placeholder is not closed.' });
  }
  return out;
}

export function isValidSnippet(s: Pick<Snippet, 'name' | 'prefix' | 'body'>): boolean {
  return validateSnippet(s).length === 0;
}

/** Plain-text preview of a snippet body: placeholders replaced by their defaults, tab stops removed. */
export function snippetPreview(body: string): string {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) { out += body[++i]; continue; }
    if (ch === '$') {
      const m = /^\$(\d+)/.exec(body.slice(i)) ?? /^\$\{(\d+)\}/.exec(body.slice(i));
      if (m) { i += m[0].length - 1; continue; }
      const p = /^\$\{\d+:/.exec(body.slice(i));
      if (p) { i += p[0].length - 1; continue; }
      const choice = /^\$\{\d+\|([^,|}]*)[^}]*\|\}/.exec(body.slice(i));
      if (choice) { out += choice[1]; i += choice[0].length - 1; continue; }
    }
    if (ch === '}') continue;
    out += ch;
  }
  return out;
}

function toItem(s: SnippetDef, score: number, range?: [number, number]): CompletionItem {
  const item: CompletionItem = {
    label: s.prefix, kind: 'snippet', detail: s.name + (s.builtin ? '' : ' · user snippet'),
    documentation: (s.description ? s.description + '\n\n' : '') + '```sql\n' + snippetPreview(s.body) + '\n```',
    insertText: s.body, isSnippet: true, sortText: sortTextFor(score), filterText: s.prefix, score, usageKey: 'snip:' + s.prefix,
  };
  if (range) item.range = range;
  return item;
}

/** Completer source: snippets at statement start, below exact keyword matches (keywords are group 9 in the completer). */
export function snippetSource(dialect: Dialect, user: () => readonly Snippet[] | null | undefined): ExtraCompletionSource {
  return (c: CursorContext, _env: CompleteEnv) => {
    void _env;
    if (!c.atStatementStart || c.qualifier) return null;
    const out: CompletionItem[] = [];
    for (const s of snippetsFor(dialect, user())) {
      const ms = matchScore(c.prefixText, s.prefix);
      if (c.prefixText && ms < 0) continue;
      out.push(toItem(s, 8000 + ms + (s.builtin ? 0 : 5)));
    }
    return out;
  };
}

/** Ctrl+J: every snippet of the dialect, matched against the word before the cursor. */
export function snippetPickerItems(dialect: Dialect, user: readonly Snippet[] | null | undefined, word: string, range: [number, number]): CompletionItem[] {
  const out: CompletionItem[] = [];
  for (const s of snippetsFor(dialect, user)) {
    const ms = matchScore(word, s.prefix);
    const nameMs = matchScore(word, s.name);
    if (word && ms < 0 && nameMs < 0) continue;
    const item = toItem(s, 1000 + Math.max(ms, nameMs), range);
    item.filterText = `${s.prefix} ${s.name}`;
    item.description = s.name;
    out.push(item);
  }
  return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** A fresh user snippet id. */
export function newSnippetId(existing: readonly { id: string }[]): string {
  let n = existing.length + 1;
  while (existing.some((s) => s.id === `s_${n}`)) n++;
  return `s_${n}`;
}
