// Monaco options of the "Compare with server" DiffEditor (CompareDialog), kept apart so tests can use them.
import * as monaco from '../editor/monaco';
import { baseMonacoOptions } from '../editor/monacoOptions';

/**
 * Options of the compare DiffEditor: the shared editor options first (light-DOM context menu with the theme colours,
 * the --font-mono code font, no rainbow brackets), then the read-only side-by-side diff's own.
 */
export function diffEditorOptions(theme: string): monaco.editor.IStandaloneDiffEditorConstructionOptions {
  return {
    ...baseMonacoOptions(),
    readOnly: true,
    originalEditable: false,
    automaticLayout: true,
    renderSideBySide: true,
    theme,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // One quiet scrollbar per side: no combined diff overview ruler next to the editors' own rulers (two stacked
    // rulers and a grey slider read as clutter), no per-side overview lanes; the tints mark the changes.
    renderOverviewRuler: false,
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    hideCursorInOverviewRuler: true,
  };
}

/** Bracket pair colorization is a text model option in standalone Monaco: turn it off on both sides (as CodeView does). */
export function plainBrackets(...models: monaco.editor.ITextModel[]): void {
  for (const m of models) m.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
}
