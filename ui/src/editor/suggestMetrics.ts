// IntelliSense row metrics derived from the editor font size. Pure (no Monaco), so it is unit-tested on its own;
// monacoOptions.ts and SqlEditor apply it as Monaco's suggestFontSize / suggestLineHeight.

/** Default editor font size (Settings › Editor › Font size). */
export const EDITOR_FONT_SIZE = 14;

/**
 * The suggest list text one pixel under the editor text (never below 12 px) and a comfortable row of ~1.85× that,
 * rounded to an even pixel count so the 16 px codicon centres crisply. Explicit values (not Monaco's 0 = "follow the
 * editor"), so the list never clips its last row while fonts are still resolving. 14 px editor → 13 px text, 24 px rows.
 */
export function suggestMetrics(editorFontSize: number = EDITOR_FONT_SIZE): { suggestFontSize: number; suggestLineHeight: number } {
  const size = Number.isFinite(editorFontSize) && editorFontSize > 0 ? editorFontSize : EDITOR_FONT_SIZE;
  const suggestFontSize = Math.max(12, Math.round(size) - 1);
  return { suggestFontSize, suggestLineHeight: Math.round((suggestFontSize * 1.85) / 2) * 2 };
}
