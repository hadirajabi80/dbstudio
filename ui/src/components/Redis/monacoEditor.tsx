// Monaco implementation of CodeEditor (see CodeEditor.tsx): one model per editor, bound by URI to the key completion
// of redis/language.ts; Ctrl/Cmd+Enter runs the line or selection, F5 / Ctrl+Shift+Enter runs all, Ctrl/Cmd+S saves.
import { useEffect, useRef } from 'react';
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, THEME_IDS } from '../../editor/monaco-setup';
import { baseMonacoOptions, remeasureAfterFonts } from '../../editor/monacoOptions';
import { bindRedisModel, ensureRedisLanguages, REDIS_JSON_LANGUAGE, REDIS_LANGUAGE } from '../../redis/language';
import type { CodeEditorProps } from './CodeEditor';

let seq = 0;

const LANGUAGE = { redis: REDIS_LANGUAGE, json: REDIS_JSON_LANGUAGE, text: 'plaintext' } as const;

export default function MonacoCodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    ensureRedisLanguages();
    const p = latest.current;
    const uri = monaco.Uri.parse(`dbstudio-redis://editor/${++seq}.${p.language}`);
    const model = monaco.editor.createModel(p.value, LANGUAGE[p.language], uri);
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
      lineHeight: 20,
      tabSize: 2,
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: p.language === 'json',
      wordWrap: p.wordWrap ? 'on' : 'off',
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, alwaysConsumeMouseWheel: false },
      suggest: { showWords: false, preview: true },
      quickSuggestions: p.language === 'redis' ? { other: true, strings: false, comments: false } : false,
      wordBasedSuggestions: 'off',
      stickyScroll: { enabled: false },
      padding: { top: 6, bottom: 6 },
    });
    ed.current = e;
    remeasureAfterFonts();
    const unbind = bindRedisModel(uri.toString(), { keys: () => latest.current.keys?.() ?? [] });
    const sub = model.onDidChangeContent(() => {
      const v = model.getValue();
      if (v !== latest.current.value) latest.current.onChange?.(v);
    });
    e.addAction({
      id: 'dbstudio.redis.runSelection', label: 'Run line or selection', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        const sel = e.getSelection();
        const m = e.getModel();
        if (!sel || !m || !latest.current.onRunSelection) return;
        const text = sel.isEmpty() ? m.getLineContent(sel.positionLineNumber) : m.getValueInRange(sel);
        latest.current.onRunSelection(text, sel.startLineNumber);
      },
    });
    e.addAction({
      id: 'dbstudio.redis.runAll', label: 'Run all', keybindings: [monaco.KeyCode.F5, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => latest.current.onRunAll?.(),
    });
    e.addAction({ id: 'dbstudio.redis.save', label: 'Save', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: () => latest.current.onSave?.() });
    if (p.autoFocus) e.focus();
    return () => {
      sub.dispose();
      unbind();
      e.dispose();
      model.dispose();
      ed.current = null;
    };
    // the editor is created once; props are read through `latest`
  }, []);

  useEffect(() => {
    const e = ed.current;
    const m = e?.getModel();
    if (m && m.getValue() !== props.value) m.setValue(props.value);
  }, [props.value]);

  useEffect(() => {
    ed.current?.updateOptions({ readOnly: !!props.readOnly, theme: THEME_IDS[props.theme] });
    monaco.editor.setTheme(THEME_IDS[props.theme]);
  }, [props.readOnly, props.theme]);

  return <div ref={host} className={`redis-code-editor ${props.className ?? ''}`} data-primary-focus />;
}
