// Monaco implementation of MongoEditor (see MongoEditor.tsx). One model per editor, bound to the completion provider
// of language.ts by URI; parse errors from mongo/shellJson.ts become markers.
import { useEffect, useRef } from 'react';
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, THEME_IDS } from '../../editor/monaco-setup';
import { baseMonacoOptions, remeasureAfterFonts } from '../../editor/monacoOptions';
import { checkShell } from '../../mongo/shellJson';
import { bindMongoModel, ensureMongoLanguage, MONGO_LANGUAGE } from './language';
import type { MongoEditorProps } from './MongoEditor';

let seq = 0;
const LINE_H = 20;

export default function MonacoMongoEditor(props: MongoEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const single = !!props.singleLine;

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    ensureMongoLanguage();
    const uri = monaco.Uri.parse(`dbstudio-mongo://editor/${++seq}.mongo`);
    const model = monaco.editor.createModel(latest.current.value, MONGO_LANGUAGE, uri);
    const p = latest.current;
    const e = monaco.editor.create(host.current, {
      ...baseMonacoOptions(),
      model,
      theme: THEME_IDS[p.theme],
      readOnly: !!p.readOnly,
      ariaLabel: p.ariaLabel,
      placeholder: p.placeholder,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: LINE_H,
      tabSize: 2,
      fixedOverflowWidgets: true,
      renderLineHighlight: single ? 'none' : 'line',
      lineNumbers: single || p.lineNumbers === false ? 'off' : 'on',
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: !single,
      lineDecorationsWidth: single ? 6 : 8,
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      wordWrap: single ? 'on' : 'off',
      scrollbar: single ? { vertical: 'hidden', horizontal: 'hidden', alwaysConsumeMouseWheel: false } : { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      suggest: { showWords: false, preview: true },
      quickSuggestions: { other: true, strings: true, comments: false },
      wordBasedSuggestions: 'off',
      contextmenu: !single,
      padding: single ? { top: 3, bottom: 3 } : { top: 4, bottom: 4 },
      guides: { indentation: !single },
      stickyScroll: { enabled: false },
    });
    model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    ed.current = e;
    remeasureAfterFonts();
    const unbind = bindMongoModel(uri.toString(), { mode: () => latest.current.mode, fields: () => latest.current.fields ?? [] });

    const validate = () => {
      const kind = latest.current.validate ?? 'doc';
      const text = model.getValue();
      if (kind === 'none' || !text.trim()) {
        monaco.editor.setModelMarkers(model, 'mongo', []);
        return;
      }
      const err = checkShell(text, kind);
      if (!err) {
        monaco.editor.setModelMarkers(model, 'mongo', []);
        return;
      }
      const pos = model.getPositionAt(err.offset);
      monaco.editor.setModelMarkers(model, 'mongo', [{
        severity: monaco.MarkerSeverity.Error, message: err.message.replace(/ \(line \d+, column \d+\)$/, ''),
        startLineNumber: pos.lineNumber, startColumn: pos.column, endLineNumber: pos.lineNumber, endColumn: pos.column + 1,
      }]);
    };
    validate();

    const fit = () => {
      if (!host.current) return;
      const h = latest.current.height;
      if (!single && typeof h === 'number') return;
      const max = latest.current.maxHeight ?? (single ? LINE_H * 6 + 6 : 400);
      const min = latest.current.minHeight ?? (single ? LINE_H + 6 : 80);
      const content = Math.min(max, Math.max(min, e.getContentHeight()));
      host.current.style.height = `${content}px`;
      e.layout();
    };
    const subs = [
      model.onDidChangeContent(() => {
        const v = model.getValue();
        if (v !== latest.current.value) latest.current.onChange?.(v);
        validate();
      }),
      e.onDidContentSizeChange(fit),
      // Escape that closes the suggest widget (or another editor popup) must not also close the dialog or reach the
      // shell's key dispatcher.
      e.onKeyDown((ev) => {
        if (ev.keyCode !== monaco.KeyCode.Escape) return;
        const popup = document.querySelector('.monaco-editor .suggest-widget.visible, .monaco-editor .parameter-hints-widget.visible, .monaco-hover:not(.hidden)');
        if (popup) ev.browserEvent.stopPropagation();
      }),
    ];
    fit();
    // Enter submits in single-line editors unless the suggest widget is open; Ctrl/Cmd+Enter everywhere.
    e.addAction({
      id: 'dbstudio.mongo.submit', label: 'Run', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => latest.current.onSubmit?.(),
    });
    if (single) {
      e.addCommand(monaco.KeyCode.Enter, () => latest.current.onSubmit?.(), '!suggestWidgetVisible');
      e.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => e.trigger('keyboard', 'type', { text: '\n' }), '!suggestWidgetVisible');
    }
    if (p.autoFocus) e.focus();
    return () => {
      subs.forEach((s) => s.dispose());
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
      if (model) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: props.value }], () => null);
    }
  }, [props.value]);

  useEffect(() => {
    ed.current?.updateOptions({ readOnly: !!props.readOnly });
  }, [props.readOnly]);

  useEffect(() => {
    monaco.editor.setTheme(THEME_IDS[props.theme]);
  }, [props.theme]);

  const fixed = !single && typeof props.height === 'number' ? props.height : undefined;
  return (
    <div
      ref={host}
      className={`mongo-editor ${single ? 'single' : 'multi'} ${props.invalid ? 'invalid' : ''} ${props.className ?? ''}`}
      style={{ height: fixed, ...props.style }}
      data-mongo-editor
    />
  );
}
