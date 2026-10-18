// styles-r1-05: Run / Explain close the suggest list and the parameter hints first, so they never stay open over the
// results and a later Enter or Tab cannot accept a stale suggestion. Stub editor; Monaco itself is not loaded.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./monaco', () => ({}));

const { dismissEditorPopups, runExplain } = await import('./actions');
const { createIntel } = await import('../intel');

type Stub = Parameters<typeof runExplain>[0];

function stubEditor(log: string[]) {
  return {
    trigger: vi.fn((source: string, id: string, payload: unknown) => log.push(`${source}:${id}:${String(payload)}`)),
    getModel: () => ({ getOffsetAt: () => 0 }),
    getSelection: () => null,
    getPosition: () => null,
  };
}

function binding(text: string) {
  const intel = createIntel('sqlite');
  intel.setDocument('inmemory://t1', text);
  return { uri: 'inmemory://t1', intel, tabId: 't1', dialect: 'sqlite' } as unknown as Parameters<typeof runExplain>[1];
}

describe('editor popups on run / explain (styles-r1-05)', () => {
  it('hides the suggest widget and the parameter hints', () => {
    const log: string[] = [];
    dismissEditorPopups(stubEditor(log));
    expect(log).toEqual(['run:hideSuggestWidget:null', 'run:closeParameterHints:null']);
  });

  for (const mode of ['estimated', 'actual'] as const) {
    it(`Explain (${mode}) closes them before dispatching`, () => {
      const log: string[] = [];
      const ed = stubEditor(log);
      const handler = vi.fn(() => log.push('explain'));
      expect(runExplain(ed as unknown as Stub, binding('SELECT * FROM customers'), mode, handler)).toBe(true);
      expect(log).toEqual(['run:hideSuggestWidget:null', 'run:closeParameterHints:null', 'explain']);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ mode, tabId: 't1' }));
    });
  }

  it('leaves the popups alone when there is nothing to explain', () => {
    const log: string[] = [];
    const ed = stubEditor(log);
    expect(runExplain(ed as unknown as Stub, binding('   '), 'estimated', vi.fn())).toBe(false);
    expect(log).toEqual([]);
  });
});
