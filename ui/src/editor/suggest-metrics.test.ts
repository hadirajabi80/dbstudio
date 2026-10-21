// IntelliSense row metrics (editor/suggestMetrics.ts): the suggest list follows the editor font size.
import { describe, expect, it } from 'vitest';
import { EDITOR_FONT_SIZE, suggestMetrics } from './suggestMetrics';

describe('suggestMetrics', () => {
  it('gives the default 14 px editor a 13 px list with comfortable 24 px rows', () => {
    expect(EDITOR_FONT_SIZE).toBe(14);
    expect(suggestMetrics()).toEqual({ suggestFontSize: 13, suggestLineHeight: 24 });
    expect(suggestMetrics(14)).toEqual(suggestMetrics());
  });

  it('follows the editor font size, never below 12 px text, rows always even and >= 1.7x the text', () => {
    let prev = suggestMetrics(9);
    for (let size = 9; size <= 32; size++) {
      const m = suggestMetrics(size);
      expect(m.suggestFontSize, `font ${size}`).toBe(Math.max(12, size - 1));
      expect(m.suggestLineHeight % 2, `row ${size}`).toBe(0);
      expect(m.suggestLineHeight / m.suggestFontSize, `row ratio ${size}`).toBeGreaterThanOrEqual(1.7);
      expect(m.suggestLineHeight - m.suggestFontSize, `row padding ${size}`).toBeGreaterThanOrEqual(10);
      expect(m.suggestLineHeight, `monotonic ${size}`).toBeGreaterThanOrEqual(prev.suggestLineHeight);
      prev = m;
    }
    expect(suggestMetrics(12)).toEqual({ suggestFontSize: 12, suggestLineHeight: 22 });
    expect(suggestMetrics(18)).toEqual({ suggestFontSize: 17, suggestLineHeight: 32 });
  });

  it('falls back to the default for a missing or broken setting', () => {
    for (const bad of [Number.NaN, 0, -3, Number.POSITIVE_INFINITY]) expect(suggestMetrics(bad), String(bad)).toEqual(suggestMetrics());
  });
});
