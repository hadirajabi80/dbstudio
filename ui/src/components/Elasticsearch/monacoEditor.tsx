// Monaco implementation of CodeEditor (see CodeEditor.tsx): one model per editor, bound to the completion providers of
// ./language.ts by URI; JSON parse errors become markers; the console gets ▶ glyphs on request lines and a highlight of
// the request at the cursor (Kibana Dev Tools style).
import { displayShortcut } from '../../commands/keys';
import { useEffect, useImperativeHandle, useRef } from 'react';
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, THEME_IDS } from '../../editor/monaco-setup';
import { baseMonacoOptions, MONACO_SCROLLBAR, remeasureAfterFonts } from '../../editor/monacoOptions';
import { parseConsole, requestAt } from '../../es/console';
import { parseLenient } from '../../es/json';
import type { CodeEditorProps } from './CodeEditor';
import { bindEsModel, ensureEsLanguages, ES_CONSOLE, ES_JSON, ES_SQL } from './language';

let seq = 0;

const LANG = { json: ES_JSON, console: ES_CONSOLE, sql: ES_SQL, text: 'plaintext' } as const;

export default function MonacoEsEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useImperativeHandle(props.handleRef, () => ({
    cursorLine: () => ed.current?.getPosition()?.lineNumber ?? 1,
    selectionLines: () => {
      const s = ed.current?.getSelection();
      if (!s || s.isEmpty()) return null;
      return { from: s.startLineNumber, to: s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber };
    },
    focus: () => ed.current?.focus(),
    goToLine: (line: number) => {
      ed.current?.setPosition({ lineNumber: line, column: 1 });
      ed.current?.revealLineInCenterIfOutsideViewport(line);
      ed.current?.focus();
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    ensureEsLanguages();
    const p = latest.current;
    const console = p.language === 'console';
    const uri = monaco.Uri.parse(`dbstudio-es://editor/${++seq}.${p.language}`);
    const model = monaco.editor.createModel(p.value, LANG[p.language], uri);
    const e = monaco.editor.create(host.current, {
      ...baseMonacoOptions(),
      model,
      theme: THEME_IDS[p.theme],
      readOnly: !!p.readOnly,
      ariaLabel: p.ariaLabel,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: 20,
      tabSize: 2,
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 3,
      glyphMargin: console,
      folding: true,
      showFoldingControls: 'mouseover',
      wordWrap: p.wordWrap ? 'on' : 'off',
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: p.readOnly ? 'none' : 'line',
      scrollbar: { ...MONACO_SCROLLBAR, alwaysConsumeMouseWheel: false },
      suggest: { showWords: false, preview: true },
      quickSuggestions: p.readOnly ? false : { other: true, strings: true, comments: false },
      wordBasedSuggestions: 'off',
      stickyScroll: { enabled: false },
      padding: { top: 6, bottom: 6 },
      guides: { indentation: true, bracketPairs: false },
    });
    model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    ed.current = e;
    remeasureAfterFonts();
    const unbind = bindEsModel(uri.toString(), () => latest.current.completion ?? null);

    const validate = () => {
      const q = latest.current;
      const on = q.language === 'json' && (q.validate ?? !q.readOnly);
      if (!on) {
        monaco.editor.setModelMarkers(model, 'es', []);
        return;
      }
      const r = parseLenient(model.getValue());
      if (r.ok) {
        monaco.editor.setModelMarkers(model, 'es', []);
        return;
      }
      const pos = model.getPositionAt(Math.min(r.offset, model.getValueLength()));
      monaco.editor.setModelMarkers(model, 'es', [{
        severity: monaco.MarkerSeverity.Error, message: r.error, startLineNumber: pos.lineNumber, startColumn: pos.column,
        endLineNumber: pos.lineNumber, endColumn: pos.column + 1,
      }]);
    };
    validate();

    // console: ▶ glyphs on request lines + highlight of the request under the cursor
    let decorations = e.createDecorationsCollection();
    const decorate = () => {
      if (!console) return;
      const reqs = parseConsole(model.getValue());
      const cur = requestAt(reqs, e.getPosition()?.lineNumber ?? 1);
      const list: monaco.editor.IModelDeltaDecoration[] = reqs.map((r) => ({
        range: new monaco.Range(r.startLine, 1, r.startLine, 1),
        options: { glyphMarginClassName: 'es-run-glyph', glyphMarginHoverMessage: { value: `Run ${r.method} ${r.path} (${displayShortcut('Mod+Enter')})` } },
      }));
      if (cur) list.push({ range: new monaco.Range(cur.startLine, 1, cur.endLine, 1), options: { isWholeLine: true, className: 'es-active-request', linesDecorationsClassName: 'es-active-request-bar' } });
      decorations.clear();
      decorations = e.createDecorationsCollection(list);
    };
    decorate();

    const subs = [
      model.onDidChangeContent(() => {
        const v = model.getValue();
        if (v !== latest.current.value) latest.current.onChange?.(v);
        validate();
        decorate();
      }),
      e.onDidChangeCursorPosition(() => decorate()),
      e.onMouseDown((ev) => {
        if (!console || ev.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        const line = ev.target.position?.lineNumber;
        if (line) latest.current.onRunLine?.(line);
      }),
      e.onKeyDown((ev) => {
        if (ev.keyCode !== monaco.KeyCode.Escape) return;
        const popup = document.querySelector('.monaco-editor .suggest-widget.visible, .monaco-editor .parameter-hints-widget.visible, .monaco-hover:not(.hidden)');
        if (popup) ev.browserEvent.stopPropagation();
      }),
    ];
    e.addAction({ id: 'dbstudio.es.run', label: 'Run', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: () => latest.current.onRun?.() });
    e.addAction({ id: 'dbstudio.es.runAll', label: 'Run all', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter], run: () => latest.current.onRunAll?.() });
    if (p.primary) e.getDomNode()?.querySelector('textarea')?.setAttribute('data-primary-focus', '');
    if (p.autoFocus) e.focus();
    return () => {
      subs.forEach((s) => s.dispose());
      decorations.clear();
      unbind();
      e.dispose();
      model.dispose();
      ed.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const e = ed.current;
    if (e && e.getValue() !== props.value) {
      const model = e.getModel();
      if (!model) return;
      if (props.readOnly) model.setValue(props.value);
      else model.pushEditOperations([], [{ range: model.getFullModelRange(), text: props.value }], () => null);
    }
  }, [props.value, props.readOnly]);

  useEffect(() => {
    ed.current?.updateOptions({ readOnly: !!props.readOnly });
  }, [props.readOnly]);

  useEffect(() => {
    monaco.editor.setTheme(THEME_IDS[props.theme]);
  }, [props.theme]);

  return <div ref={host} className={`es-monaco ${props.className ?? ''}`} style={props.height ? { height: props.height } : undefined} data-es-editor={props.language} />;
}
