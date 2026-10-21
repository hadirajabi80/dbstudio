// Redis command table (docs/PLAN-M2.md 5.4): the same redis-commands.json the engine embeds (an engine test asserts
// both copies are identical). Drives Workbench/CLI completion, hover docs, argument hints and the client-side
// read-only hint; the engine enforces read-only itself.
import table from './redis-commands.json';

export interface RedisCommandSpec {
  /** Upper case; container sub-commands are two words ("CONFIG GET"). */
  name: string;
  group: string;
  summary: string;
  syntax: string;
  since: string;
  complexity: string;
  arity: number;
  /** readonly | write | admin | blocking | transaction | blocked | dangerous | pubsub | module */
  flags: string[];
  /** [first, last, step] argument positions of key names (1 = first argument; sub-command words count). */
  keys?: number[];
}

export const COMMANDS: readonly RedisCommandSpec[] = table as RedisCommandSpec[];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** First words with sub-commands (CONFIG, CLIENT, XGROUP...). */
export const CONTAINERS: ReadonlySet<string> = new Set(COMMANDS.filter((c) => c.name.includes(' ')).map((c) => c.name.split(' ')[0]));

/** Top-level words: plain commands plus containers. */
export const TOP_LEVEL: readonly string[] = [...new Set(COMMANDS.map((c) => c.name.split(' ')[0]))].sort();

export function getCommand(name: string): RedisCommandSpec | undefined {
  return byName.get(name.toUpperCase());
}

/** The spec of a parsed command line (two-word container commands first). */
export function findCommand(args: readonly string[]): RedisCommandSpec | undefined {
  if (!args.length) return undefined;
  const first = args[0].toUpperCase();
  if (args.length > 1 && CONTAINERS.has(first)) {
    const sub = byName.get(`${first} ${args[1].toUpperCase()}`);
    if (sub) return sub;
  }
  return byName.get(first);
}

/** Sub-commands of a container ("CONFIG" → CONFIG GET, CONFIG SET...). */
export function subCommands(container: string): RedisCommandSpec[] {
  const p = `${container.toUpperCase()} `;
  return COMMANDS.filter((c) => c.name.startsWith(p));
}

/** Whether argument `index` (0 = command word) of a command is a key name. */
export function isKeyArgument(spec: RedisCommandSpec | undefined, index: number, argc: number): boolean {
  const k = spec?.keys;
  if (!k || index < 1) return false;
  const [first, last, step] = k;
  const end = last < 0 ? argc + last : last;
  if (index < first) return false;
  if (last >= 0 && index > end) return false;
  if (last < -1 && index > Math.max(first, end)) return false;
  return (index - first) % (step || 1) === 0;
}

export const isReadOnlyCommand = (spec: RedisCommandSpec | undefined) => !!spec?.flags.includes('readonly');
export const isRefusedCommand = (spec: RedisCommandSpec | undefined) => !!spec?.flags.includes('blocked');

/** Markdown documentation of a command (hover, completion details, CLI `help`). */
export function commandDoc(spec: RedisCommandSpec): string {
  const lines = [`**${spec.name}** — ${spec.summary}`, '', '```', spec.syntax, '```'];
  const meta = [`since ${spec.since}`, spec.complexity && `complexity ${spec.complexity}`, `group ${spec.group}`].filter(Boolean);
  lines.push('', meta.join(' · '));
  if (spec.flags.includes('blocked')) lines.push('', '_Not available in the Workbench/CLI._');
  else if (!spec.flags.includes('readonly')) lines.push('', '_Writes: refused on read-only connections._');
  return lines.join('\n');
}

/** Keyword tokens of a syntax line (NX, XX, EX, WITHSCORES...), for argument completion. */
export function syntaxKeywords(spec: RedisCommandSpec): string[] {
  const rest = spec.syntax.slice(spec.name.length);
  const words = rest.match(/\b[A-Z][A-Z0-9_-]+\b/g) ?? [];
  return [...new Set(words.filter((w) => w !== 'O'))];
}

/** Positional placeholders of a syntax line ("key", "value", "seconds"...), in order. */
export function syntaxPlaceholders(spec: RedisCommandSpec): string[] {
  const rest = spec.syntax.slice(spec.name.length);
  return [...rest.matchAll(/(?<![A-Z_-])[a-z][a-z0-9-]*(?![A-Za-z])/g)].map((m) => m[0]);
}

/** redis-cli style `help <command>` text. */
export function helpText(name: string): string | null {
  const spec = getCommand(name);
  return spec ? `${spec.syntax}\n  summary: ${spec.summary}\n  since: ${spec.since}${spec.complexity ? `\n  complexity: ${spec.complexity}` : ''}\n  group: ${spec.group}` : null;
}
