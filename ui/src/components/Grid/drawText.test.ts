// The grid's text draw path: RTL values are drawn with ctx.direction = 'rtl' and right-aligned, LTR text stays left,
// numbers stay right, and the canvas direction is reset for the next cell. Glide's text-cell editor keeps dir="auto".
import { GridCellKind, textCellRenderer, type GridCell, type Theme } from '@glideapps/glide-data-grid';
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { drawCellText, isRtlCell, textAlignFor } from './drawText';

interface Call { text: string; x: number; direction: string; textAlign: string }

/** A 2D context that records every fillText with the direction and alignment in effect. */
function fakeCtx() {
  const calls: Call[] = [];
  const stack: { direction: string; textAlign: string; font: string }[] = [];
  const ctx = {
    direction: 'inherit', textAlign: 'start', font: '13px mono', fillStyle: '#000', textBaseline: 'middle',
    save() { stack.push({ direction: this.direction, textAlign: this.textAlign, font: this.font }); },
    restore() { Object.assign(this, stack.pop()); },
    fillText(text: string, x: number) { calls.push({ text, x, direction: this.direction, textAlign: this.textAlign }); },
    measureText(t: string) { return { width: t.length * 7, actualBoundingBoxAscent: 9, actualBoundingBoxDescent: 3, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, raw: ctx };
}

const theme = {
  baseFontStyle: '13px', fontFamily: 'mono', cellHorizontalPadding: 8, cellVerticalPadding: 3, textDark: '#000', lineHeight: 1.4,
  baseFontFull: '13px mono',
} as unknown as Theme;
const rect = { x: 100, y: 0, width: 200, height: 28 };
const text = (displayData: string, contentAlign: 'left' | 'right' | 'center'): GridCell => ({
  kind: GridCellKind.Text, data: displayData, displayData, allowOverlay: false, contentAlign,
});

/** glide's drawContent for a text cell (the real renderer). */
const glideDraw = (ctx: CanvasRenderingContext2D, cell: GridCell) => () =>
  textCellRenderer.draw({ ctx, rect, theme, cell, hoverAmount: 0 } as unknown as Parameters<typeof textCellRenderer.draw>[0], cell as never);

describe('textAlignFor', () => {
  it('RTL values of text columns align right; LTR text left; numbers and booleans keep their column alignment', () => {
    expect(textAlignFor('left', 'علی رضایی')).toBe('right');
    expect(textAlignFor('left', '12 سفارش')).toBe('right');
    expect(textAlignFor('left', 'Order #12 سفارش')).toBe('left');
    expect(textAlignFor('left', 'Ada')).toBe('left');
    expect(textAlignFor('right', '12.5')).toBe('right');
    expect(textAlignFor('center', 'true')).toBe('center');
  });
});

describe('drawCellText', () => {
  it('draws an RTL value right-to-left at the right padding, then resets the direction', () => {
    const { ctx, calls, raw } = fakeCtx();
    const cell = text('علی', 'right');
    expect(isRtlCell(cell)).toBe(true);
    drawCellText({ ctx, rect, theme, cell }, glideDraw(ctx, cell), new Map());
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: 'علی', direction: 'rtl', textAlign: 'right' });
    expect(calls[0].x).toBeCloseTo(rect.x + rect.width - 8.5);
    expect(raw.direction).toBe('inherit');
    expect(raw.textAlign).toBe('start');
  });

  it('a mixed numbers-first RTL value is drawn as one RTL run (the browser orders the digits)', () => {
    const { ctx, calls } = fakeCtx();
    const cell = text('12 سفارش', 'right');
    drawCellText({ ctx, rect, theme, cell }, glideDraw(ctx, cell), new Map());
    expect(calls[0]).toMatchObject({ text: '12 سفارش', direction: 'rtl' });
  });

  it('LTR text stays left-to-right at the left padding', () => {
    const { ctx, calls } = fakeCtx();
    const cell = text('Order #12 سفارش', 'left');
    expect(isRtlCell(cell)).toBe(false);
    drawCellText({ ctx, rect, theme, cell }, glideDraw(ctx, cell), new Map());
    expect(calls[0].direction).toBe('inherit');
    expect(calls[0].x).toBeCloseTo(rect.x + 8.5);
  });

  it('numbers stay right-aligned without switching the direction', () => {
    const { ctx, calls } = fakeCtx();
    const cell = text('1234.50', 'right');
    drawCellText({ ctx, rect, theme, cell }, glideDraw(ctx, cell), new Map());
    expect(calls[0]).toMatchObject({ direction: 'inherit', textAlign: 'right' });
  });

  it('a truncated RTL value keeps its logical start and gets the ellipsis at its end (drawn on the left)', () => {
    const { ctx, calls, raw } = fakeCtx();
    const long = 'خرید از فروشگاه آنلاین با کد تخفیف و ارسال رایگان به شیراز، اصفهان و مشهد';
    const cell = text(long, 'right');
    let glideCalled = false;
    drawCellText({ ctx, rect: { ...rect, width: 120 }, theme, cell }, () => (glideCalled = true), new Map());
    expect(glideCalled).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].direction).toBe('rtl');
    expect(calls[0].textAlign).toBe('right');
    expect(calls[0].text.endsWith('…')).toBe(true);
    expect(long.startsWith(calls[0].text.slice(0, -1).trimEnd())).toBe(true);
    expect(raw.direction).toBe('inherit');
  });

  it('non-text cells go straight to glide', () => {
    const { ctx } = fakeCtx();
    let called = 0;
    drawCellText({ ctx, rect, theme, cell: { kind: GridCellKind.Boolean, data: true, allowOverlay: false } }, () => called++, new Map());
    expect(called).toBe(1);
  });
});

describe('overlay editor', () => {
  it("glide's text editor is a dir=\"auto\" textarea, so Persian is typed right-to-left", () => {
    const cell = text('علی رضایی', 'right') as Parameters<NonNullable<typeof textCellRenderer.provideEditor>>[0];
    const provided = textCellRenderer.provideEditor!(cell) as { editor: (p: Record<string, unknown>) => ReturnType<typeof createElement> };
    const Editor = provided.editor;
    const editorProps: Record<string, unknown> = { value: cell, onChange: () => undefined, isHighlighted: false, onFinishedEditing: () => undefined };
    const { container } = render(createElement(Editor, editorProps));
    const ta = container.querySelector('textarea');
    expect(ta).not.toBeNull();
    expect(ta!.getAttribute('dir')).toBe('auto');
    expect(ta!.value).toBe('علی رضایی');
  });
});
