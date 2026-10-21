// Workbench / CLI completion (docs/PLAN-M2.md 5.4): command names, then sub-commands of containers, then key names
// from the browser's scan cache after a key-taking argument, otherwise the syntax keywords (NX, EX, WITHSCORES...).
import { lineContext, quoteArg } from './args';
import { findCommand, getCommand, isKeyArgument, subCommands, syntaxKeywords, syntaxPlaceholders, CONTAINERS, TOP_LEVEL, type RedisCommandSpec } from './catalog';

export type SuggestionKind = 'command' | 'subcommand' | 'keyword' | 'key';

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  /** Text that replaces the partial word. */
  insert: string;
  /** One-line description (command summary, key type...). */
  detail?: string;
  spec?: RedisCommandSpec;
}

export interface SuggestResult {
  items: Suggestion[];
  /** Offset in the text where the replaced word starts. */
  start: number;
}

const MAX = 200;

/** Suggestions for the text before the caret of one command line. `keys` lists cached key names (browser scans). */
export function suggest(textBeforeCaret: string, keys: () => readonly string[] = () => []): SuggestResult {
  const ctx = lineContext(textBeforeCaret);
  const prefix = ctx.current.toUpperCase();
  if (ctx.args.length === 0) {
    const items = TOP_LEVEL.filter((n) => n.startsWith(prefix)).slice(0, MAX).map<Suggestion>((n) => {
      const spec = getCommand(n);
      return {
        label: n, kind: 'command', insert: n, spec,
        detail: spec?.summary ?? (CONTAINERS.has(n) ? `${subCommands(n).map((s) => s.name.split(' ')[1]).join(', ')}` : undefined),
      };
    });
    return { items, start: ctx.start };
  }
  const first = ctx.args[0].toUpperCase();
  if (ctx.args.length === 1 && CONTAINERS.has(first)) {
    const items = subCommands(first).map((s) => s.name.split(' ')[1]).filter((w) => w.startsWith(prefix)).map<Suggestion>((w) => {
      const spec = getCommand(`${first} ${w}`);
      return { label: w, kind: 'subcommand', insert: w, detail: spec?.summary, spec };
    });
    return { items, start: ctx.start };
  }
  const spec = findCommand(ctx.args);
  const index = ctx.args.length;
  if (isKeyArgument(spec, index, index + 1)) {
    const lower = ctx.current;
    const items: Suggestion[] = [];
    for (const k of keys()) {
      if (!k.startsWith(lower)) continue;
      items.push({ label: k, kind: 'key', insert: ctx.inQuote ? k : quoteArg(k) });
      if (items.length >= MAX) break;
    }
    return { items, start: ctx.start };
  }
  if (!spec) return { items: [], start: ctx.start };
  const used = new Set(ctx.args.map((a) => a.toUpperCase()));
  const items = syntaxKeywords(spec).filter((w) => w.startsWith(prefix) && !used.has(w)).map<Suggestion>((w) => ({ label: w, kind: 'keyword', insert: w }));
  return { items, start: ctx.start };
}

/** Argument hint for the caret position: the syntax and the placeholder being typed (when positional). */
export function signature(textBeforeCaret: string): { spec: RedisCommandSpec; placeholder: string | null } | null {
  const ctx = lineContext(textBeforeCaret);
  if (!ctx.args.length) return null;
  const spec = findCommand(ctx.args);
  if (!spec) return null;
  const words = spec.name.split(' ').length;
  const pos = ctx.args.length - words;
  const placeholders = syntaxPlaceholders(spec);
  return { spec, placeholder: pos >= 0 ? placeholders[pos] ?? null : null };
}
