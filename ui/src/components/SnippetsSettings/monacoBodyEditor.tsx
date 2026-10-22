// Monaco implementation of SnippetBodyEditor: the dialect's Rowlit SQL language and theme, no line numbers, word
// wrap, auto height between MIN_H and MAX_H, and the tab stops ($1, ${1:x}, $0) marked like in the previews.
import { useEffect, useLayoutEffect, useRef } from 'react';
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, LANGUAGE_IDS, THEME_IDS } from '../../editor/monaco-setup';
import { baseMonacoOptions, remeasureAfterFonts } from '../../editor/monacoOptions';
import { placeholders } from './code';
import type { SnippetBodyEditorProps } from './SnippetBodyEditor';

const MIN_H = 132;
const MAX_H = 320;
let seq = 0;

function placeholderDecorations(model: monaco.editor.ITextModel): monaco.editor.IModelDeltaDecoration[] {
  const out: monaco.editor.IModelDeltaDecoration[] = [];
  for (let ln = 1; ln <= model.getLineCount(); ln++) {
    for (const p of placeholders(model.getLineContent(ln))) {
      out.push({
        range: new monaco.Range(ln, p.start + 1, ln, p.end + 1),
        options: { inlineClassName: p.final ? 'snip-ph snip-ph-final' : 'snip-ph', stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      });
    }
  }
  return out;
}

/** Monaco's focusable input (a textarea, or the EditContext element when that is enabled). */
function inputOf(host: HTMLElement | null): HTMLElement | null {
  return host?.querySelector<HTMLElement>('textarea, .native-edit-context') ?? null;
}

export default function MonacoBodyEditor(p: SnippetBodyEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    const el = host.current;
    const model = monaco.editor.createModel(latest.current.value, LANGUAGE_IDS[latest.current.dialect], monaco.Uri.parse(`dbstudio-snippet://body/${++seq}.sql`));
    const e = monaco.editor.create(el, {
      ...baseMonacoOptions(),
      model,
      theme: THEME_IDS[latest.current.theme],
      ariaLabel: latest.current.ariaLabel,
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 20,
      padding: { top: 8, bottom: 8 },
      lineNumbers: 'off',
      lineNumbersMinChars: 0,
      lineDecorationsWidth: 10,
      glyphMargin: false,
      folding: false,
      wordWrap: 'on',
      wrappingIndent: 'same',
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: 'none',
      stickyScroll: { enabled: false },
      scrollbar: { horizontal: 'hidden', verticalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      // a form field: Tab moves to the next control (no keyboard trap); the console is where SQL is written
      tabFocusMode: true,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      wordBasedSuggestions: 'off',
      parameterHints: { enabled: false },
      occurrencesHighlight: 'off',
      selectionHighlight: false,
    });
    ed.current = e;
    remeasureAfterFonts();

    const deco = e.createDecorationsCollection(placeholderDecorations(model));
    const fit = () => {
      const h = Math.min(MAX_H, Math.max(MIN_H, e.getContentHeight()));
      if (el.style.height !== `${h}px`) el.style.height = `${h}px`;
    };
    fit();
    const subs = [
      e.onDidContentSizeChange(fit),
      model.onDidChangeContent(() => {
        deco.set(placeholderDecorations(model));
        const v = model.getValue();
        if (v !== latest.current.value) latest.current.onChange(v);
      }),
    ];
    return () => {
      subs.forEach((s) => s.dispose());
      e.dispose();
      model.dispose();
      ed.current = null;
    };
  }, []);

  // Outside changes (another snippet selected, Revert): replace the text.
  useEffect(() => {
    const model = ed.current?.getModel();
    if (model && model.getValue() !== p.value) model.setValue(p.value);
  }, [p.value]);

  useEffect(() => {
    const model = ed.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, LANGUAGE_IDS[p.dialect]);
  }, [p.dialect]);

  useEffect(() => {
    monaco.editor.setTheme(THEME_IDS[p.theme]);
  }, [p.theme]);

  // The validation semantics of the textarea it replaces, on Monaco's own input element.
  useEffect(() => {
    const input = inputOf(host.current);
    if (!input) return;
    input.setAttribute('aria-invalid', String(p.invalid));
    input.setAttribute('aria-describedby', p.describedBy);
  });

  return <div ref={host} className={`snip-body-editor${p.invalid ? ' invalid' : ''}`} style={{ height: MIN_H }} />;
}
