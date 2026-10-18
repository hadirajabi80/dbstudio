// Formatter fixture tests (PLAN-M1.5 1.2 step 6): for every fixture `<dialect>/NN-name.sql`
// - the output equals `NN-name.expected.sql` (regenerate with UPDATE_FORMAT_FIXTURES=1 and review the diff),
// - formatting is idempotent,
// - the token sequence is unchanged (words compared case-insensitively, everything else byte for byte; a `;` may
//   move before the comments right in front of it),
// - every comment survives with identical text (block comment continuation lines may be re-indented),
// - only fixtures named `*broken*` produce warnings (and those keep the broken statement verbatim).
import { describe, expect, it } from 'vitest';
import { canonicalTokens, commentKey, formatSql } from '../index';
import { getSpec } from '../../intel/dialect';
import { tokenize } from '../../intel/lexer/lexer';
import type { Dialect, Token } from '../../intel/types';

const ENV = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const UPDATE = ENV.UPDATE_FORMAT_FIXTURES === '1';
const RAW = import.meta.glob('./fixtures/*/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Writes an expected file (UPDATE_FORMAT_FIXTURES=1 or missing file); node:fs is loaded only then. */
async function writeExpected(rel: string, text: string): Promise<void> {
  const fsMod = (await import(/* @vite-ignore */ 'node:fs' as string)) as { writeFileSync(p: URL, t: string): void };
  fsMod.writeFileSync(new URL(rel, import.meta.url), text);
}

function norm(tokens: Token[]): string[] {
  return canonicalTokens(tokens).map((t) =>
    t.kind === 'keyword' || t.kind === 'ident' || t.kind === 'batchSep' || t.kind === 'op'
      ? `${t.kind}:${t.upper}`
      : t.kind === 'comment'
        ? `comment:${commentKey(t.text)}`
        : `${t.kind}:${t.text}`,
  );
}

export function fixtureFiles(dialect: Dialect): string[] {
  const prefix = `./fixtures/${dialect}/`;
  return Object.keys(RAW).filter((k) => k.startsWith(prefix) && !k.endsWith('.expected.sql')).map((k) => k.slice(prefix.length)).sort();
}

for (const dialect of ['tsql', 'plsql', 'sqlite'] as Dialect[]) {
  describe(`formatter fixtures: ${dialect}`, () => {
    const spec = getSpec(dialect);
    const files = fixtureFiles(dialect);
    it('has at least 40 fixtures', () => expect(files.length).toBeGreaterThanOrEqual(40));
    for (const f of files) {
      it(f, async () => {
        const input = RAW[`./fixtures/${dialect}/${f}`];
        const r = formatSql(input, dialect);
        const rel = `./fixtures/${dialect}/${f.replace(/\.sql$/, '.expected.sql')}`;
        if (UPDATE || RAW[rel] === undefined) await writeExpected(rel, r.text);
        else expect(r.text).toBe(RAW[rel]);
        // idempotency
        expect(formatSql(r.text, dialect).text).toBe(r.text);
        // token equality (comments included)
        const before = tokenize(input, spec), after = tokenize(r.text, spec);
        expect(norm(after)).toEqual(norm(before));
        // comment preservation
        const comments = (ts: Token[]) => ts.filter((t) => t.kind === 'comment').map((t) => commentKey(t.text));
        expect(comments(after)).toEqual(comments(before));
        if (f.includes('broken')) expect(r.warnings.length).toBeGreaterThan(0);
        else expect(r.warnings).toEqual([]);
      });
    }
  });
}
