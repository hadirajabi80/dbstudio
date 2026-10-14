// Snapshot tests: every language x flavor x dialect on the shop fixture. The C# snapshots are compiled by
// engine/tests/Codegen.Smoke (dotnet build), so they double as compile fixtures. TypeScript snapshots end in .ts.snap
// so the app's own `tsc -b` does not try to compile them (they import driver packages the UI does not depend on).
import { describe, expect, it } from 'vitest';
import { generate, joinFiles, LANGUAGES, flavorsFor } from '..';
import type { CodegenOptions } from '../options';
import { DIALECTS, shopInput } from './shop';

const COMMENT: Record<string, string> = { python: '#', sql: '--', json: '//' };

function nsFor(lang: string, flavor: string, dialect: string): string {
  const id = `${flavor}_${dialect}`.replace(/[^A-Za-z0-9]+/g, '_');
  if (lang === 'csharp') return `Shop.${id.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('')}`;
  if (lang === 'java') return `com.example.shop.${id.toLowerCase()}`;
  if (lang === 'go') return 'shop';
  return '';
}

describe('codegen snapshots (shop fixture)', () => {
  for (const lang of LANGUAGES) {
    for (const dialect of DIALECTS) {
      for (const flavor of flavorsFor(lang.id, dialect)) {
        it(`${lang.id} / ${flavor.id} / ${dialect}`, async () => {
          const opts: Partial<CodegenOptions> = {
            language: lang.id, flavor: flavor.id, namespace: nsFor(lang.id, flavor.id, dialect), combined: true,
            include: { model: true, repository: true, procedures: true, interface: lang.id === 'csharp' && flavor.id === 'dapper' },
          };
          const files = generate(shopInput(dialect), opts);
          expect(files.length).toBeGreaterThan(0);
          const text = joinFiles(files, COMMENT[lang.id] ?? '//');
          await expect(text).toMatchFileSnapshot(`./__snapshots__/${lang.id}/${flavor.id}.${dialect}.${lang.extension}${lang.id === 'typescript' ? '.snap' : ''}`);
        });
      }
    }
  }
});
