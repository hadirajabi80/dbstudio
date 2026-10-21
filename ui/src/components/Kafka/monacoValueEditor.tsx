// Monaco implementation of ValueEditor: a Monarch JSON language (`dbstudio-kafka-json`) and parse-error markers.
import { useEffect, useRef } from 'react';
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, THEME_IDS } from '../../editor/monaco-setup';
import { baseMonacoOptions } from '../../editor/monacoOptions';
import type { ValueEditorProps } from './ValueEditor';

const JSON_LANGUAGE = 'dbstudio-kafka-json';
let registered = false;
let seq = 0;

function ensureLanguage() {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: JSON_LANGUAGE });
  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE, {
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/\$\{i\}/, 'variable'],
        [/[{}[\],:]/, 'delimiter'],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE, {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
  });
}

/** Parse error marker (the `${i}` placeholder of "Repeat N times" is accepted as a number). */
function markers(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const text = model.getValue().replace(/\$\{i\}/g, '0');
  if (!text.trim()) return [];
  try {
    JSON.parse(text);
    return [];
  } catch (e) {
    const m = /position (\d+)/.exec(String(e));
    const pos = model.getPositionAt(m ? Number(m[1]) : text.length);
    return [{ severity: monaco.MarkerSeverity.Error, message: String((e as Error).message), startLineNumber: pos.lineNumber, startColumn: pos.column,
      endLineNumber: pos.lineNumber, endColumn: pos.column + 1 }];
  }
}

export default function MonacoValueEditor(p: ValueEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    ensureLanguage();
    const lang = latest.current.language === 'json' ? JSON_LANGUAGE : 'plaintext';
    const model = monaco.editor.createModel(latest.current.value, lang, monaco.Uri.parse(`dbstudio-kafka://value/${++seq}`));
    const e = monaco.editor.create(host.current, {
      ...baseMonacoOptions(), model, theme: THEME_IDS[latest.current.theme], ariaLabel: latest.current.ariaLabel, automaticLayout: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, lineHeight: 20, tabSize: 2, lineNumbersMinChars: 3, glyphMargin: false,
      overviewRulerLanes: 0, stickyScroll: { enabled: false }, wordBasedSuggestions: 'off', quickSuggestions: false,
    });
    ed.current = e;
    const check = () => monaco.editor.setModelMarkers(model, 'kafka-json', latest.current.language === 'json' ? markers(model) : []);
    check();
    const sub = model.onDidChangeContent(() => {
      latest.current.onChange(model.getValue());
      check();
    });
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => latest.current.onSubmit?.());
    return () => {
      sub.dispose();
      e.dispose();
      model.dispose();
      ed.current = null;
    };
  }, []);

  useEffect(() => {
    const model = ed.current?.getModel();
    if (model && model.getValue() !== p.value) model.setValue(p.value);
  }, [p.value]);

  useEffect(() => {
    const model = ed.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, p.language === 'json' ? JSON_LANGUAGE : 'plaintext');
  }, [p.language]);

  useEffect(() => {
    monaco.editor.setTheme(THEME_IDS[p.theme]);
  }, [p.theme]);

  return <div ref={host} className="kafka-monaco" style={{ height: p.height ?? 220 }} />;
}
