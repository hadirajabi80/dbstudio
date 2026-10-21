// Tab-stop marking of the colourised snippet code: placeholder ranges and the split of coloured tokens at their edges.
import { describe, expect, it } from 'vitest';
import { placeholders, plainLines, previewDialect, segmentLine } from './code';

describe('snippet code helpers', () => {
  it('finds $1, ${1}, ${1:default}, nested defaults, choices and $0; not an escaped \\$', () => {
    const line = 'SELECT ${1:*} FROM ${2:t ${3:x}} WHERE a = $4 \\$5 ${6|asc,desc|}$0';
    const found = placeholders(line).map((p) => line.slice(p.start, p.end));
    expect(found).toEqual(['${1:*}', '${2:t ${3:x}}', '$4', '${6|asc,desc|}', '$0']);
    expect(placeholders('$0').map((p) => p.final)).toEqual([true]);
    expect(placeholders('${0:end}').map((p) => p.final)).toEqual([true]);
    expect(placeholders('$10').map((p) => p.final)).toEqual([false]);
  });

  it('splits coloured tokens at placeholder boundaries and tags the runs', () => {
    const tokens = [{ cls: 'mtk5', text: 'FROM' }, { cls: 'mtk1', text: ' ${2:tab' }, { cls: 'mtk1', text: 'le} x' }];
    const text = tokens.map((t) => t.text).join('');
    const segs = segmentLine(tokens, placeholders(text));
    expect(segs).toEqual([
      { cls: 'mtk5', text: 'FROM', ph: -1 },
      { cls: 'mtk1', text: ' ', ph: -1 },
      { cls: 'mtk1', text: '${2:table}', ph: 0 },
      { cls: 'mtk1', text: ' x', ph: -1 },
    ]);
    expect(segs.map((s) => s.text).join('')).toBe(text);
  });

  it('plain lines and the preview dialect', () => {
    expect(plainLines('a\r\n\tb\n')).toEqual([[{ cls: '', text: 'a' }], [{ cls: '', text: '    b' }], []]);
    expect(previewDialect(null)).toBe('tsql');
    expect(previewDialect(['pgsql', 'sqlite'])).toBe('pgsql');
  });
});
