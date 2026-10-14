import type { CatalogSnapshot } from '../../api/types';
import { createIntel, type Intel } from '../index';
import type { CompletionItem, CompletionResult, Dialect, IntelOptions } from '../types';
import tsqlShop from './fixtures/shop-tsql.json';
import plsqlShop from './fixtures/shop-plsql.json';
import sqliteShop from './fixtures/shop-sqlite.json';

export const fixtures: Record<Dialect, CatalogSnapshot> = {
  tsql: tsqlShop as unknown as CatalogSnapshot,
  plsql: plsqlShop as unknown as CatalogSnapshot,
  sqlite: sqliteShop as unknown as CatalogSnapshot,
};

const cache = new Map<string, Intel>();

/** Intel with the shop fixture loaded (shared per dialect; documents are per test uri). */
export function intelFor(dialect: Dialect, opts?: Partial<IntelOptions>): Intel {
  const key = dialect + JSON.stringify(opts ?? {});
  let i = cache.get(key);
  if (!i) {
    i = createIntel(dialect, opts);
    i.setCatalog(fixtures[dialect]);
    cache.set(key, i);
  }
  return i;
}

let n = 0;

/** `|` marks the cursor. */
export function withCursor(input: string): { text: string; offset: number } {
  const offset = input.indexOf('|');
  if (offset < 0) return { text: input, offset: input.length };
  return { text: input.slice(0, offset) + input.slice(offset + 1), offset };
}

export function doc(intel: Intel, input: string): { uri: string; text: string; offset: number } {
  const { text, offset } = withCursor(input);
  const uri = `test://${++n}`;
  intel.setDocument(uri, text);
  return { uri, text, offset };
}

export function complete(dialect: Dialect, input: string, opts?: Partial<IntelOptions>, intel?: Intel): CompletionResult & { uri: string; text: string; offset: number } {
  const i = intel ?? intelFor(dialect, opts);
  const d = doc(i, input);
  return { ...i.complete(d.uri, d.offset), ...d };
}

export function labels(items: CompletionItem[], n = items.length): string[] {
  return items.slice(0, n).map((x) => x.label);
}

export function find(items: CompletionItem[], label: string, pred?: (x: CompletionItem) => boolean): CompletionItem | undefined {
  return items.find((x) => x.label === label && (!pred || pred(x)));
}

export function indexOf(items: CompletionItem[], label: string, pred?: (x: CompletionItem) => boolean): number {
  return items.findIndex((x) => x.label === label && (!pred || pred(x)));
}

export const stripMd = (s: string) => s.replace(/[`*_]/g, '');
