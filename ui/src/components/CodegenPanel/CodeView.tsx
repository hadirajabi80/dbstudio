// Read-only Monaco for generated code, with the target language's syntax colouring (Monarch tokenizers only:
// no language services are loaded, so the bundle stays small).
import { useEffect, useRef } from 'react';
import * as monaco from '../../editor/monaco';
import { ensureMonacoSetup, THEME_IDS } from '../../editor/monaco-setup';
import { baseMonacoOptions, remeasureAfterFonts } from '../../editor/monacoOptions';
import { bindEditorFontSize, editorFontSize } from '../../editor/fontZoom';
import type { EffectiveTheme } from '../../theme/useTheme';

const LOADERS: Record<string, () => Promise<unknown>> = {
  csharp: () => import('monaco-editor/languages/definitions/csharp/register.js'),
  go: () => import('monaco-editor/languages/definitions/go/register.js'),
  typescript: () => import('monaco-editor/languages/definitions/typescript/register.js'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/register.js'),
  java: () => import('monaco-editor/languages/definitions/java/register.js'),
  python: () => import('monaco-editor/languages/definitions/python/register.js'),
  sql: () => import('monaco-editor/languages/definitions/sql/register.js'),
};

/** JSON has no Monarch definition here; JavaScript's colours it well enough. */
const ALIAS: Record<string, string> = { json: 'javascript' };

const loaded = new Map<string, Promise<unknown>>();

export function ensureLanguage(id: string): Promise<string> {
  const lang = ALIAS[id] ?? id;
  const load = LOADERS[lang];
  if (!load) return Promise.resolve('plaintext');
  let p = loaded.get(lang);
  if (!p) {
    p = load().catch((e) => console.warn(`[codegen] could not load ${lang} colouring`, e));
    loaded.set(lang, p);
  }
  return p.then(() => lang);
}

export function CodeView({ value, language, theme, label }: { value: string; language: string; theme: EffectiveTheme; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!host.current) return;
    ensureMonacoSetup();
    // Shared options first (code font, light-DOM context views, no rainbow brackets), then the read-only view's own.
    const e = monaco.editor.create(host.current, {
      ...baseMonacoOptions(),
      value,
      language: 'plaintext',
      readOnly: true,
      domReadOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: editorFontSize(), // Settings.editor.fontSize, live (bindEditorFontSize)
      theme: THEME_IDS[theme],
      ariaLabel: label,
      renderLineHighlight: 'none',
      tabSize: language === 'go' ? 4 : undefined,
    });
    // Bracket pair colorization is a text model option: the editor option in baseMonacoOptions() does not reach the
    // model in standalone Monaco (only the dotted `bracketPairColorization.enabled` key is a configuration key), so
    // the gold / orchid / blue bracket colours would stay. Turn it off on the model itself.
    e.getModel()?.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    ed.current = e;
    const unbindFont = bindEditorFontSize(e, { suggest: false });
    remeasureAfterFonts();
    return () => {
      unbindFont();
      e.getModel()?.dispose();
      e.dispose();
      ed.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const e = ed.current;
    if (e && e.getValue() !== value) e.setValue(value);
  }, [value]);

  useEffect(() => {
    let live = true;
    void ensureLanguage(language).then((lang) => {
      const model = ed.current?.getModel();
      if (live && model) monaco.editor.setModelLanguage(model, lang);
    });
    return () => {
      live = false;
    };
  }, [language]);

  useEffect(() => {
    monaco.editor.setTheme(THEME_IDS[theme]);
  }, [theme]);

  return <div ref={host} className="cg-code" />;
}
