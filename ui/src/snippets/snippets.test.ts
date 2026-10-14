// Snippets (A4): dialect filtering, user overrides, validation, completion at statement start, Ctrl+J items and
// postfix templates through the completer's extraSources hook.
import { describe, expect, it } from 'vitest';
import { createIntel } from '../intel';
import { postfixSource } from '../intel/complete/postfix';
import type { CatalogSnapshot, Snippet } from '../api/types';
import tsqlShop from '../intel/__tests__/fixtures/shop-tsql.json';
import sqliteShop from '../intel/__tests__/fixtures/shop-sqlite.json';
import { BUILTIN_SNIPPETS, snippetPickerItems, snippetPreview, snippetSource, snippetsFor, validateSnippet } from './index';

const user: Snippet[] = [
  { id: 's_1', name: 'My select', prefix: 'sel', dialects: null, body: 'SELECT TOP 5 * FROM ${1:t}$0' },
  { id: 's_2', name: 'Oracle only', prefix: 'ora', dialects: ['plsql'], body: 'SELECT 1 FROM dual' },
];

function intelWith(dialect: 'tsql' | 'sqlite', text: string, snippets: Snippet[] = []) {
  const intel = createIntel(dialect);
  intel.setCatalog((dialect === 'tsql' ? tsqlShop : sqliteShop) as unknown as CatalogSnapshot);
  intel.setExtraCompletionSources([snippetSource(dialect, () => snippets), postfixSource]);
  const offset = text.indexOf('|');
  intel.setDocument('u', text.replace('|', ''));
  return intel.complete('u', offset);
}

describe('snippet sets', () => {
  it('every dialect has the PLAN A4 prefixes', () => {
    const want: Record<string, string[]> = {
      tsql: ['sel', 'selw', 'selc', 'ins', 'upd', 'del', 'cte', 'join', 'case', 'ifx', 'tryc', 'proc', 'fn', 'trg', 'tbl', 'idx', 'tx', 'cur'],
      plsql: ['sel', 'selw', 'selc', 'ins', 'upd', 'del', 'cte', 'join', 'case', 'blk', 'proc', 'fn', 'pkg', 'trg', 'cur', 'exc', 'tbl', 'idx', 'tx'],
      sqlite: ['sel', 'selw', 'selc', 'ins', 'upd', 'del', 'cte', 'join', 'case', 'trg', 'tbl', 'idx', 'tx'],
    };
    for (const [d, prefixes] of Object.entries(want)) {
      const have = new Set(snippetsFor(d as 'tsql', []).map((s) => s.prefix));
      for (const p of prefixes) expect(have, `${d}:${p}`).toContain(p);
    }
  });

  it('prefixes are unique per dialect and built-in bodies are valid', () => {
    for (const d of ['tsql', 'plsql', 'sqlite'] as const) {
      const list = snippetsFor(d, []);
      expect(new Set(list.map((s) => s.prefix)).size).toBe(list.length);
    }
    for (const s of BUILTIN_SNIPPETS) expect(validateSnippet(s), s.id).toEqual([]);
  });

  it('user snippets override built-ins with the same prefix and respect their dialect filter', () => {
    const t = snippetsFor('tsql', user);
    expect(t.find((s) => s.prefix === 'sel')!.body).toBe(user[0].body);
    expect(t.some((s) => s.prefix === 'ora')).toBe(false);
    expect(snippetsFor('plsql', user).some((s) => s.prefix === 'ora')).toBe(true);
  });

  it('validation', () => {
    expect(validateSnippet({ name: '', prefix: 'a b', body: '' }).map((p) => p.field)).toEqual(['name', 'prefix', 'body']);
    expect(validateSnippet({ name: 'x', prefix: 'sel', body: 'SELECT ${1:a' })[0].field).toBe('body');
    expect(validateSnippet({ name: 'x', prefix: 'sel', body: 'x' }, [{ prefix: 'SEL', dialects: null }])[0].message).toContain('already');
  });

  it('preview strips placeholders', () => {
    expect(snippetPreview('SELECT ${1:*}\nFROM ${2:table}$0 \\$x ${3|a,b|}')).toBe('SELECT *\nFROM table $x a');
  });
});

describe('completion', () => {
  it('snippets appear at statement start, ranked below the matching keyword', () => {
    const r = intelWith('tsql', 'sel|');
    const labels = r.items.map((i) => `${i.kind}:${i.label}`);
    const kw = labels.indexOf('keyword:SELECT'), sn = labels.indexOf('snippet:sel');
    expect(kw).toBeGreaterThanOrEqual(0);
    expect(sn).toBeGreaterThan(kw);
    expect(r.items.filter((i) => i.kind === 'snippet' && i.label === 'sel')).toHaveLength(1);
  });

  it('a user snippet replaces the built-in with the same prefix', () => {
    const r = intelWith('tsql', 'sel|', user);
    const sel = r.items.filter((i) => i.kind === 'snippet' && i.label === 'sel');
    expect(sel).toHaveLength(1);
    expect(sel[0].insertText).toBe(user[0].body);
  });

  it('no snippets in the middle of a statement', () => {
    const r = intelWith('tsql', 'SELECT * FROM Customers WHERE se|');
    expect(r.items.some((i) => i.kind === 'snippet' && i.label === 'sel')).toBe(false);
  });

  it('Ctrl+J items match prefix or name', () => {
    const items = snippetPickerItems('tsql', [], 'try', [0, 3]);
    expect(items[0].label).toBe('tryc');
    expect(items[0].range).toEqual([0, 3]);
    expect(snippetPickerItems('tsql', [], '', [0, 0]).length).toBeGreaterThan(15);
  });
});

describe('postfix templates', () => {
  it('Customers.sel → SELECT * FROM Customers replacing the whole chain', () => {
    const text = 'Customers.sel';
    const r = intelWith('tsql', text + '|');
    const item = r.items.find((i) => i.kind === 'snippet' && i.label === 'sel')!;
    expect(item).toBeTruthy();
    expect(item.insertText).toBe('SELECT * FROM Customers$0');
    expect(item.range).toEqual([0, text.length]);
    expect(item.filterText).toBe('Customers.sel');
  });

  it('.count, .ins with insertable columns, .upd, .del', () => {
    const r = intelWith('sqlite', 'customers.|');
    const by = (k: string) => r.items.find((i) => i.kind === 'snippet' && i.label === k)!;
    expect(by('count').insertText).toBe('SELECT COUNT(*) FROM customers$0');
    expect(by('ins').insertText).toMatch(/^INSERT INTO customers \(.+\)\nVALUES \(\$\{1:.+\}/);
    expect(by('upd').insertText).toContain('UPDATE customers\nSET');
    expect(by('del').insertText).toContain('DELETE FROM customers\nWHERE');
  });

  it('not offered for unknown tables or mid-statement qualifiers', () => {
    expect(intelWith('tsql', 'Nope.sel|').items.some((i) => i.detail?.startsWith('postfix'))).toBe(false);
    expect(intelWith('tsql', 'SELECT * FROM Customers c WHERE c.sel|').items.some((i) => i.detail?.startsWith('postfix'))).toBe(false);
  });
});
