// Options shared by every Monaco editor in DbStudio: the SQL console (SqlEditor), CodeView, the designer DDL
// previews and the DiffEditor. Spread them first and add the editor-specific options after.
import * as monaco from './monaco';
import { cssVar } from '../theme/gridTheme';
import { EDITOR_FONT_SIZE, suggestMetrics } from './suggestMetrics';

export { EDITOR_FONT_SIZE, suggestMetrics };

/** IntelliSense row metrics at the default editor font size (SqlEditor re-derives them from Settings). */
export const SUGGEST_FONT_SIZE = suggestMetrics().suggestFontSize;
export const SUGGEST_LINE_HEIGHT = suggestMetrics().suggestLineHeight;

export function baseMonacoOptions(): monaco.editor.IEditorOptions {
  return {
    // The context menu and other context views render in the light DOM, where Monaco's theme variables
    // (--vscode-menu-background, ...) apply; inside the default shadow root they are undefined (QA styles-01).
    useShadowDOM: false,
    // section 3 code font, the same stack as the grid (--font-mono), so macOS gets SF Mono / Menlo, not Courier
    fontFamily: cssVar('--font-mono', 'monospace'),
    suggestLineHeight: SUGGEST_LINE_HEIGHT,
    suggestFontSize: SUGGEST_FONT_SIZE,
    bracketPairColorization: { enabled: false },
    scrollbar: MONACO_SCROLLBAR,
  };
}

/**
 * Slim scrollbars for every Monaco editor, diff included: a 10 px track with a centred 6 px pill (rounded in
 * editor-widgets.css), the same look as the app's ::-webkit-scrollbar (app.css), and no drop shadow when scrolled.
 */
export const MONACO_SCROLLBAR = {
  verticalScrollbarSize: 10,
  horizontalScrollbarSize: 10,
  verticalSliderSize: 6,
  horizontalSliderSize: 6,
  useShadows: false,
} as const satisfies monaco.editor.IEditorScrollbarOptions;

let loadingHooked = false;

/**
 * Re-measures every editor's font metrics once the document fonts have loaded (and after any later font load),
 * so character widths, line heights and the suggest list are computed with the real code font, not a fallback.
 * Idempotent; call it after creating an editor.
 */
export function remeasureAfterFonts(): void {
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (!fonts) return;
  void fonts.ready.then(() => monaco.editor.remeasureFonts());
  if (!loadingHooked && typeof fonts.addEventListener === 'function') {
    loadingHooked = true;
    fonts.addEventListener('loadingdone', () => monaco.editor.remeasureFonts());
  }
}
