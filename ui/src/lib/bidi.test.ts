// Right-to-left detection of data values by the Unicode first-strong-character rule, and RTL text surviving copy.
import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../api/types';
import { dirFor, firstStrongDirection, isRtlText } from './bidi';
import { serializeRows, type CopyFormat } from './serialize';

describe('firstStrongDirection / isRtlText', () => {
  it('Persian, Arabic and Hebrew are RTL', () => {
    expect(isRtlText('علی رضایی')).toBe(true);
    expect(isRtlText('مریم احمدی')).toBe(true);
    expect(isRtlText('محمد')).toBe(true);
    expect(isRtlText('שלום עולם')).toBe(true);
  });

  it('Syriac, Thaana, N’Ko and the Arabic presentation forms are RTL', () => {
    expect(isRtlText('ܐܒ')).toBe(true); // Syriac
    expect(isRtlText('ފަ')).toBe(true); // Thaana
    expect(isRtlText('ߊߋ')).toBe(true); // N'Ko
    expect(isRtlText('ﻻ')).toBe(true); // lam-alef, presentation forms B
    expect(isRtlText('ﷲ')).toBe(true); // presentation forms A
    expect(isRtlText('שׁ')).toBe(true); // Hebrew presentation form
  });

  it('LTR text, empty strings and values without a strong character are not RTL', () => {
    expect(isRtlText('Ada Lovelace')).toBe(false);
    expect(isRtlText('Ünal')).toBe(false);
    expect(isRtlText('Привет')).toBe(false);
    expect(isRtlText('東京')).toBe(false);
    expect(isRtlText('')).toBe(false);
    expect(firstStrongDirection('')).toBeNull();
    expect(firstStrongDirection('12 345.6')).toBeNull();
    expect(firstStrongDirection('۱۲۳')).toBeNull(); // Persian digits are weak (EN)
    expect(firstStrongDirection('٣٤')).toBeNull(); // Arabic-Indic digits are weak (AN)
  });

  it('mixed strings follow their first strong character', () => {
    expect(isRtlText('Order #12 سفارش')).toBe(false);
    expect(isRtlText('سفارش Order #12')).toBe(true);
    expect(isRtlText('Sara سارا کریمی')).toBe(false);
  });

  it('numbers, spaces and punctuation before the first letter are skipped', () => {
    expect(isRtlText('12 سفارش')).toBe(true);
    expect(isRtlText('۱۲ سفارش')).toBe(true);
    expect(isRtlText('  (#42) - سفارش')).toBe(true);
    expect(isRtlText('12 orders')).toBe(false);
    expect(isRtlText('ًب')).toBe(true); // a combining mark first is skipped
  });

  it('RLM and LRM marks are strong characters', () => {
    expect(isRtlText('‏Order 12')).toBe(true);
    expect(isRtlText('‎علی')).toBe(false);
    expect(isRtlText('12 ‏%')).toBe(true);
  });

  it('supplementary-plane RTL scripts (Adlam) are RTL, supplementary LTR letters are not', () => {
    expect(isRtlText('\u{1E900}\u{1E901}')).toBe(true);
    expect(isRtlText('\u{10400}')).toBe(false); // Deseret
  });

  it('is cached per value and stays consistent', () => {
    for (let i = 0; i < 3; i++) {
      expect(isRtlText('12 سفارش')).toBe(true);
      expect(isRtlText('12 orders')).toBe(false);
    }
  });

  it('dirFor gives rtl for RTL values and auto for anything else', () => {
    expect(dirFor('علی')).toBe('rtl');
    expect(dirFor('Ali')).toBe('auto');
    expect(dirFor(null)).toBe('auto');
  });

  it('detection is fast: 100k values well under a frame budget per visible screen', () => {
    const values = Array.from({ length: 100_000 }, (_, i) => (i % 3 === 0 ? `مشتری شماره ${i}` : i % 3 === 1 ? `${i} سفارش` : `Customer ${i}`));
    const t0 = performance.now();
    let n = 0;
    for (const v of values) if (isRtlText(v)) n++;
    const cold = performance.now() - t0;
    const t1 = performance.now();
    for (const v of values) if (isRtlText(v)) n++;
    const warm = performance.now() - t1;
    expect(n).toBe(2 * Math.round((100_000 * 2) / 3));
    // generous bounds for slow CI machines; typical: ~20 ms cold, ~5 ms warm for 100k values
    expect(cold).toBeLessThan(1000);
    expect(warm).toBeLessThan(500);
  });
});

describe('copy keeps RTL text intact', () => {
  const col = (name: string, kind: ColumnKind): ColumnInfo => ({
    name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table: 'customers', schema: null, isKey: false,
  });
  const columns = [col('id', 'int'), col('name', 'string'), col('notes', 'string')];
  const rows: CellValue[][] = [[2, 'علی رضایی', 'Order #12 سفارش'], [3, 'محمد', '12 سفارش در انتظار']];
  const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/;

  for (const format of ['tsv', 'csv', 'json', 'markdown', 'sql-insert'] as CopyFormat[]) {
    it(`${format}: no bidi control characters are injected and the values are unchanged`, () => {
      const out = serializeRows(format, columns, rows, { dialect: 'sqlite', header: true });
      expect(out).not.toMatch(BIDI_CONTROLS);
      for (const v of ['علی رضایی', 'Order #12 سفارش', 'محمد', '12 سفارش در انتظار']) expect(out).toContain(v);
    });
  }
});
