import { describe, expect, it } from 'vitest';
import { fieldMatch, paletteMatch, rankPalette } from './paletteScore';

const CMDS = [
  { title: 'Generate code from query…', category: 'Code' },
  { title: 'Generate code…', category: 'Code' },
  { title: 'Toggle compact density', category: 'Preferences', keywords: 'row height grid' },
  { title: 'Disconnect all', category: 'Connections' },
  { title: 'Toggle confirmation of destructive statements', category: 'Preferences' },
  { title: 'Collapse all explorer nodes', category: 'Database' },
  { title: 'Command palette', category: 'View' },
  { title: 'Toggle record view', category: 'Data' },
  { title: 'Toggle results pane', category: 'View' },
  { title: 'New console', category: 'File' },
  { title: 'Copy qualified name', category: 'Database' },
  { title: 'Run script', category: 'Query' },
];

function search(q: string): string[] {
  const hits = CMDS.flatMap((c) => {
    const m = paletteMatch(q, c);
    return m ? [{ item: c.title, match: m }] : [];
  });
  return rankPalette(hits, q).map((h) => h.item);
}

describe('palette matching (design-20)', () => {
  it('"code" finds the codegen commands only (no scattered letters)', () => {
    expect(search('code')).toEqual(['Generate code…', 'Generate code from query…']);
  });

  it('"copy" does not match "Toggle compact density"', () => {
    expect(search('copy')).toEqual(['Copy qualified name']);
  });

  it('word-start chunks and acronyms still work', () => {
    expect(search('newcon')).toEqual(['New console']);
    expect(search('nc')[0]).toBe('New console');
    expect(search('tog res')[0]).toBe('Toggle results pane');
  });

  it('title matches rank above category matches', () => {
    const r = search('query');
    expect(r[0]).toBe('Generate code from query…');
    expect(r).toContain('Run script'); // category "Query"
    expect(r.indexOf('Run script')).toBeGreaterThan(0);
  });

  it('rejects mid-word scattered subsequences', () => {
    expect(fieldMatch('code', 'Disconnect all')).toBeNull();
    expect(fieldMatch('code', 'Collapse all explorer nodes')).toBeNull();
  });
});
