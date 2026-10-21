// Editor font size: every SQL Monaco editor (consoles, F4 edit consoles, object/DDL tabs, designer previews, the
// codegen view and the Compare diff) follows Settings.editor.fontSize live, and Ctrl + mouse wheel (⌘ + wheel on
// macOS) over an editor changes it by 1 px, clamped 9–32. The new size is stored through the settings store, whose
// PUT is debounced, so it survives restarts and the Settings dialog shows it. The app's whole-window zoom
// (Ctrl + = / Ctrl + -, app/zoom.ts) and the results grid are not touched. Monaco-free (structural editor type).
import { isMac } from '../commands/keys';
import { useSettings } from '../store/settings';
import { suggestMetrics } from './suggestMetrics';

export const EDITOR_FONT_MIN = 9;
export const EDITOR_FONT_MAX = 32;
/** Wheel distance (CSS px) per 1 px font step: one mouse notch (~100 px) is one step; a trackpad needs a deliberate swipe. */
export const WHEEL_STEP_PX = 60;
/** Accumulated trackpad deltas older than this are dropped, so a pause starts a fresh gesture. */
const GESTURE_IDLE_MS = 250;

export function clampEditorFontSize(n: number): number {
  const v = Number.isFinite(n) ? Math.round(n) : 14;
  return Math.max(EDITOR_FONT_MIN, Math.min(EDITOR_FONT_MAX, v));
}

/** The editor font size from the settings store, clamped. */
export function editorFontSize(): number {
  return clampEditorFontSize(useSettings.getState().settings.editor.fontSize);
}

/** Ctrl + wheel zooms the editor; on macOS ⌘ + wheel (and a trackpad pinch, which the browser reports as Ctrl + wheel). */
export function isZoomWheel(e: Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, mac = isMac()): boolean {
  if (e.altKey || e.shiftKey) return false;
  return mac ? e.metaKey || e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Turns wheel deltas into font-size steps: deltas accumulate until they cross WHEEL_STEP_PX, then one step is taken
 * and the remainder dropped, so a single event never jumps more than one size and trackpad streams of small deltas
 * step smoothly. Wheel up (negative deltaY) is +1.
 */
export class WheelStepper {
  private acc = 0;
  private last = 0;

  step(e: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, now = Date.now()): -1 | 0 | 1 {
    // DOM_DELTA_LINE (Firefox: 3 lines per notch) and DOM_DELTA_PAGE count as at least one notch
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * WHEEL_STEP_PX : e.deltaY;
    if (now - this.last > GESTURE_IDLE_MS || Math.sign(dy) !== Math.sign(this.acc)) this.acc = 0;
    this.last = now;
    this.acc += dy;
    if (Math.abs(this.acc) < WHEEL_STEP_PX) return 0;
    const dir = this.acc < 0 ? 1 : -1;
    this.acc = 0;
    return dir;
  }
}

/** What fontZoom needs from a Monaco code or diff editor. */
export interface FontZoomTarget {
  updateOptions(o: { fontSize: number; suggestFontSize?: number; suggestLineHeight?: number }): void;
  getContainerDomNode(): HTMLElement;
}

export interface FontZoomOptions {
  /** Ctrl + wheel changes the size (default true). */
  wheel?: boolean;
  /** Also apply the IntelliSense row metrics (default true; the diff editor has no suggest list). */
  suggest?: boolean;
}

function badge(container: HTMLElement): (size: number) => void {
  let el: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (size) => {
    if (!el) {
      el = document.createElement('div');
      el.className = 'editor-zoom-badge';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(el);
    }
    el.textContent = `Editor font ${size} px`;
    el.classList.add('visible');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => el?.classList.remove('visible'), 1200);
  };
}

/**
 * Keeps an editor on Settings.editor.fontSize (now and on every change) and, unless `wheel: false`, handles
 * Ctrl/⌘ + wheel over it. The wheel listener runs in the capture phase on the editor's container and cancels the
 * event, so neither the page/window zooms nor the editor scrolls. Returns the cleanup.
 */
export function bindEditorFontSize(ed: FontZoomTarget, options: FontZoomOptions = {}): () => void {
  const withSuggest = options.suggest !== false;
  const apply = (size: number) => ed.updateOptions({ fontSize: size, ...(withSuggest ? suggestMetrics(size) : {}) });
  apply(editorFontSize());
  const unsubscribe = useSettings.subscribe((s, prev) => {
    if (s.settings.editor.fontSize !== prev.settings.editor.fontSize) apply(clampEditorFontSize(s.settings.editor.fontSize));
  });
  if (options.wheel === false) return unsubscribe;

  const container = ed.getContainerDomNode();
  const stepper = new WheelStepper();
  const show = badge(container);
  const onWheel = (e: WheelEvent) => {
    if (!isZoomWheel(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = stepper.step(e);
    if (!dir) return;
    const cur = editorFontSize();
    const next = clampEditorFontSize(cur + dir);
    show(next);
    if (next !== cur) useSettings.getState().update({ editor: { fontSize: next } });
  };
  container.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    unsubscribe();
    container.removeEventListener('wheel', onWheel, { capture: true });
    container.querySelector(':scope > .editor-zoom-badge')?.remove();
  };
}
