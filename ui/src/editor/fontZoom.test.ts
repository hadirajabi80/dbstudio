// @vitest-environment jsdom
// Ctrl + mouse wheel editor font zoom (editor/fontZoom.ts): the wheel with Ctrl (⌘ on macOS) steps and clamps
// Settings.editor.fontSize, without the modifier nothing happens, trackpad deltas accumulate, and every bound editor
// follows the setting live.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const putSettings = vi.fn(() => Promise.resolve());
vi.mock('../api/client', () => ({ api: { putSettings, getSettings: vi.fn(() => Promise.resolve({})) } }));

const { setPlatformForTests } = await import('../commands/keys');
const { DEFAULT_SETTINGS, useSettings } = await import('../store/settings');
const { bindEditorFontSize, clampEditorFontSize, EDITOR_FONT_MAX, EDITOR_FONT_MIN, isZoomWheel, WheelStepper, WHEEL_STEP_PX } = await import('./fontZoom');
const { suggestMetrics } = await import('./suggestMetrics');

function fakeEditor() {
  const container = document.createElement('div');
  const inner = document.createElement('div'); // stands in for Monaco's scrollable element
  container.appendChild(inner);
  document.body.appendChild(container);
  const innerWheel = vi.fn();
  inner.addEventListener('wheel', innerWheel);
  return { container, inner, innerWheel, ed: { updateOptions: vi.fn(), getContainerDomNode: () => container } };
}

function wheel(target: HTMLElement, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...init });
  target.dispatchEvent(e);
  return e;
}

const fontSize = () => useSettings.getState().settings.editor.fontSize;

beforeEach(() => {
  vi.useFakeTimers();
  setPlatformForTests(false);
  useSettings.setState({ settings: DEFAULT_SETTINGS });
});
afterEach(() => {
  vi.useRealTimers();
  setPlatformForTests(null);
  document.body.innerHTML = '';
});

describe('isZoomWheel', () => {
  it('is Ctrl + wheel on Windows / Linux, ⌘ + wheel (or a pinch, reported as Ctrl) on macOS', () => {
    const k = (o: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>>) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
    expect(isZoomWheel(k({ ctrlKey: true }), false)).toBe(true);
    expect(isZoomWheel(k({}), false)).toBe(false);
    expect(isZoomWheel(k({ metaKey: true }), false)).toBe(false);
    expect(isZoomWheel(k({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
    expect(isZoomWheel(k({ metaKey: true }), true)).toBe(true);
    expect(isZoomWheel(k({ ctrlKey: true }), true)).toBe(true);
    expect(isZoomWheel(k({}), true)).toBe(false);
    expect(isZoomWheel(k({ metaKey: true, altKey: true }), true)).toBe(false);
  });
});

describe('WheelStepper', () => {
  it('takes one step per mouse notch, up is bigger', () => {
    const s = new WheelStepper();
    expect(s.step({ deltaY: -100, deltaMode: 0 }, 0)).toBe(1);
    expect(s.step({ deltaY: 100, deltaMode: 0 }, 10)).toBe(-1);
    expect(s.step({ deltaY: -3, deltaMode: 1 }, 20)).toBe(1); // Firefox: 3 lines per notch
  });

  it('never jumps more than one size per event', () => {
    expect(new WheelStepper().step({ deltaY: -2000, deltaMode: 0 }, 0)).toBe(1);
  });

  it('accumulates small trackpad deltas, and restarts after a pause or a direction change', () => {
    const s = new WheelStepper();
    const n = Math.ceil(WHEEL_STEP_PX / 8);
    const steps = Array.from({ length: n }, (_, i) => s.step({ deltaY: -8, deltaMode: 0 }, i * 16));
    expect(steps.slice(0, -1).every((x) => x === 0)).toBe(true);
    expect(steps[steps.length - 1]).toBe(1);
    // half a step, then a pause: the next half alone does not step
    expect(s.step({ deltaY: -WHEEL_STEP_PX / 2, deltaMode: 0 }, 1000)).toBe(0);
    expect(s.step({ deltaY: -WHEEL_STEP_PX / 2 - 1, deltaMode: 0 }, 2000)).toBe(0);
    // reversing drops what was accumulated the other way
    expect(s.step({ deltaY: WHEEL_STEP_PX - 1, deltaMode: 0 }, 2010)).toBe(0);
  });
});

describe('bindEditorFontSize', () => {
  it('applies the setting (with the IntelliSense metrics) and follows later changes live', () => {
    const { ed } = fakeEditor();
    const off = bindEditorFontSize(ed);
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ fontSize: 14, ...suggestMetrics(14) });
    useSettings.getState().update({ editor: { fontSize: 18 } });
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ fontSize: 18, ...suggestMetrics(18) });
    off();
    useSettings.getState().update({ editor: { fontSize: 20 } });
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ fontSize: 18, ...suggestMetrics(18) });
  });

  it('Ctrl + wheel up / down changes the setting by 1 px and keeps the editor from scrolling', () => {
    const { ed, inner, innerWheel, container } = fakeEditor();
    bindEditorFontSize(ed, { suggest: false });
    const up = wheel(inner, { deltaY: -100, ctrlKey: true });
    expect(up.defaultPrevented).toBe(true);
    expect(innerWheel).not.toHaveBeenCalled();
    expect(fontSize()).toBe(15);
    expect(ed.updateOptions).toHaveBeenLastCalledWith({ fontSize: 15 });
    vi.advanceTimersByTime(300);
    wheel(inner, { deltaY: 100, ctrlKey: true });
    vi.advanceTimersByTime(300);
    wheel(inner, { deltaY: 100, ctrlKey: true });
    expect(fontSize()).toBe(13);
    // the indicator
    const badge = container.querySelector('.editor-zoom-badge');
    expect(badge?.textContent).toBe('Editor font 13 px');
    expect(badge?.classList.contains('visible')).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(badge?.classList.contains('visible')).toBe(false);
    // persisted through the settings store (its PUT is debounced)
    expect(putSettings).toHaveBeenCalled();
    expect(putSettings).toHaveBeenLastCalledWith(expect.objectContaining({ editor: expect.objectContaining({ fontSize: 13 }) }));
  });

  it('does nothing without the modifier: the editor scrolls as usual', () => {
    const { ed, inner, innerWheel } = fakeEditor();
    bindEditorFontSize(ed);
    const e = wheel(inner, { deltaY: -100 });
    expect(e.defaultPrevented).toBe(false);
    expect(innerWheel).toHaveBeenCalledTimes(1);
    expect(fontSize()).toBe(14);
    wheel(inner, { deltaY: -100, metaKey: true }); // ⌘ is not the modifier on Windows
    expect(fontSize()).toBe(14);
  });

  it('uses ⌘ on macOS', () => {
    setPlatformForTests(true);
    const { ed, inner } = fakeEditor();
    bindEditorFontSize(ed);
    expect(wheel(inner, { deltaY: -100, metaKey: true }).defaultPrevented).toBe(true);
    expect(fontSize()).toBe(15);
  });

  it(`clamps to ${EDITOR_FONT_MIN}–${EDITOR_FONT_MAX} px`, () => {
    const { ed, inner } = fakeEditor();
    bindEditorFontSize(ed);
    useSettings.getState().update({ editor: { fontSize: EDITOR_FONT_MAX } });
    vi.advanceTimersByTime(300);
    wheel(inner, { deltaY: -100, ctrlKey: true });
    expect(fontSize()).toBe(EDITOR_FONT_MAX);
    useSettings.getState().update({ editor: { fontSize: EDITOR_FONT_MIN } });
    vi.advanceTimersByTime(300);
    wheel(inner, { deltaY: 100, ctrlKey: true });
    expect(fontSize()).toBe(EDITOR_FONT_MIN);
    expect(clampEditorFontSize(3)).toBe(EDITOR_FONT_MIN);
    expect(clampEditorFontSize(99)).toBe(EDITOR_FONT_MAX);
    expect(clampEditorFontSize(Number.NaN)).toBe(14);
  });

  it('removes its wheel handler on cleanup', () => {
    const { ed, inner } = fakeEditor();
    const off = bindEditorFontSize(ed);
    off();
    expect(wheel(inner, { deltaY: -100, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(fontSize()).toBe(14);
  });
});
