// styles-r1-03: the "Compare with server" DiffEditor uses the shared Monaco options like every other editor: its
// context menu renders in the light DOM (where the theme's --vscode-* colours apply), it uses the --font-mono code
// font, and neither side colours bracket pairs.
import { describe, expect, it } from 'vitest';
import { diffEditorOptions, plainBrackets } from '../compareOptions';

describe('Compare DiffEditor options (styles-r1-03)', () => {
  it('spreads the shared options before its own', () => {
    const o = diffEditorOptions('dbstudio-light');
    expect(o.useShadowDOM).toBe(false);
    expect(o.bracketPairColorization).toEqual({ enabled: false });
    expect(typeof o.fontFamily).toBe('string');
    expect(o).toMatchObject({ readOnly: true, originalEditable: false, renderSideBySide: true, theme: 'dbstudio-light' });
  });

  it('renders the context menu in the light DOM and leaves brackets uncoloured on both sides', async () => {
    const canvas = HTMLCanvasElement.prototype as unknown as { getContext: unknown };
    const getContext = canvas.getContext;
    const noop: ProxyHandler<object> = {
      get: (_t, p) => (p === 'measureText' ? () => ({ width: 0 }) : p === 'createImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => undefined),
      set: () => true,
    };
    canvas.getContext = () => new Proxy({}, noop);
    const monaco = await import('../../editor/monaco');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const original = monaco.editor.createModel('SELECT (1) FROM t', 'sql');
    const modified = monaco.editor.createModel('SELECT (2) FROM t', 'sql');
    const diff = monaco.editor.createDiffEditor(host, { ...diffEditorOptions('vs'), fixedOverflowWidgets: true });
    diff.setModel({ original, modified });
    plainBrackets(original, modified);
    try {
      for (const m of [original, modified]) expect(m.getOptions().bracketPairColorizationOptions.enabled).toBe(false);
      const ed = diff.getModifiedEditor();
      ed.focus();
      await ed.getAction('editor.action.showContextMenu')!.run();
      await new Promise((r) => setTimeout(r, 30));
      expect(document.querySelector('.shadow-root-host'), 'context view inside a shadow root').toBeNull();
      const view = document.querySelector<HTMLElement>('.context-view');
      expect(view, 'context view in the light DOM').not.toBeNull();
      expect(view!.querySelector('.monaco-menu'), 'menu rendered').not.toBeNull();
    } finally {
      diff.dispose();
      original.dispose();
      modified.dispose();
      host.remove();
      document.querySelectorAll('.context-view').forEach((n) => n.remove());
      canvas.getContext = getContext;
    }
  }, 20000);
});
