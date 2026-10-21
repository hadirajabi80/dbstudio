// Shortcut sheet key search: held-modifier hints, combination and chord search, typing in the search box, AltGr.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installKeyDispatcher } from '../../commands/dispatcher';
import { setPlatformForTests } from '../../commands/keys';
import { registerCommands, resetCommandsForTests, type Command } from '../../commands/registry';
import { useUi } from '../../store/ui';
import {
  bindingsWithModifiers, classifyKeyDown, eventModifiers, hintAnnouncement, HINT_DELAY_MS, searchStroke, spokenShortcut, type KeyContext,
} from './keySearch';
import { ShortcutSheet } from './ShortcutSheet';

const ctx = (o: Partial<KeyContext> = {}): KeyContext => ({ textField: false, recording: false, chordPending: false, altGraph: false, ...o });
const ev = (o: Partial<KeyboardEvent>) => ({ key: 'l', code: 'KeyL', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });

describe('keySearch rules', () => {
  afterEach(() => setPlatformForTests(null));

  it('reads the held modifier set (Mod is ⌘ on macOS, Ctrl or Win elsewhere)', () => {
    expect(eventModifiers({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }, false)).toBe('ctrl+alt');
    expect(eventModifiers({ ctrlKey: false, altKey: false, shiftKey: true, metaKey: true }, false)).toBe('ctrl+shift');
    expect(eventModifiers({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: true }, true)).toBe('ctrl+macctrl+alt');
  });

  it('modifier presses hint; Shift alone does not while typing in the search box (unless recording)', () => {
    setPlatformForTests(false);
    expect(classifyKeyDown(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), ctx(), false)).toEqual({ kind: 'modifiers', mods: 'ctrl' });
    expect(classifyKeyDown(ev({ key: 'Alt', code: 'AltLeft', ctrlKey: true, altKey: true }), ctx({ textField: true }), false)).toEqual({ kind: 'modifiers', mods: 'ctrl+alt' });
    const shift = ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(classifyKeyDown(shift, ctx({ textField: true }), false)).toEqual({ kind: 'modifiers', mods: '' });
    expect(classifyKeyDown(shift, ctx({ textField: true, recording: true }), false)).toEqual({ kind: 'modifiers', mods: 'shift' });
    expect(classifyKeyDown(shift, ctx(), false)).toEqual({ kind: 'modifiers', mods: 'shift' });
  });

  it('AltGr is never Ctrl+Alt: the AltGraph key clears the hints and AltGr characters are typed', () => {
    setPlatformForTests(false);
    expect(classifyKeyDown(ev({ key: 'AltGraph', code: 'AltRight', ctrlKey: true, altKey: true }), ctx(), false)).toEqual({ kind: 'modifiers', mods: '' });
    expect(classifyKeyDown(ev({ key: 'Alt', code: 'AltRight', ctrlKey: true, altKey: true }), ctx({ altGraph: true }), false)).toEqual({ kind: 'modifiers', mods: '' });
    expect(classifyKeyDown(ev({ key: 'ł', ctrlKey: true, altKey: true }), ctx({ textField: true }), false)).toEqual({ kind: 'pass' });
    expect(classifyKeyDown(ev({ key: '{', code: 'Digit7', ctrlKey: true, altKey: true }), ctx(), false)).toEqual({ kind: 'pass' });
    expect(classifyKeyDown(ev({ key: 'l', ctrlKey: true, altKey: true }), ctx({ altGraph: true, recording: true }), false)).toEqual({ kind: 'pass' });
    // a real Ctrl+Alt+L is a shortcut
    expect(classifyKeyDown(ev({ key: 'l', ctrlKey: true, altKey: true }), ctx({ textField: true }), false)).toEqual({ kind: 'stroke', stroke: 'ctrl+alt+l' });
  });

  it('the search box keeps typing and editing keys; command combinations and F-keys are looked up', () => {
    setPlatformForTests(false);
    const t = ctx({ textField: true });
    expect(classifyKeyDown(ev({ key: 'f', code: 'KeyF' }), t, false).kind).toBe('pass');
    expect(classifyKeyDown(ev({ key: 'F', code: 'KeyF', shiftKey: true }), t, false).kind).toBe('pass');
    for (const k of [{ key: 'a', code: 'KeyA' }, { key: 'c', code: 'KeyC' }, { key: 'v', code: 'KeyV' }, { key: 'z', code: 'KeyZ' }, { key: 'ArrowLeft', code: 'ArrowLeft' }, { key: 'Backspace', code: 'Backspace' }]) {
      expect(classifyKeyDown(ev({ ...k, ctrlKey: true }), t, false).kind, k.key).toBe('pass');
    }
    expect(classifyKeyDown(ev({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true }), t, false).kind).toBe('pass');
    expect(classifyKeyDown(ev({ key: 'Escape', code: 'Escape' }), t, false).kind).toBe('pass');
    expect(classifyKeyDown(ev({ key: 'Tab', code: 'Tab', shiftKey: true }), t, false).kind).toBe('pass');
    expect(classifyKeyDown(ev({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }), t, false)).toEqual({ kind: 'stroke', stroke: 'ctrl+shift+p' });
    expect(classifyKeyDown(ev({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, altKey: true }), t, false)).toEqual({ kind: 'stroke', stroke: 'ctrl+alt+arrowright' });
    expect(classifyKeyDown(ev({ key: 'F5', code: 'F5' }), t, false)).toEqual({ kind: 'stroke', stroke: 'f5' });
    expect(classifyKeyDown(ev({ key: '1', code: 'Digit1', altKey: true }), t, false)).toEqual({ kind: 'stroke', stroke: 'alt+1' });
    // outside a text field plain keys stay navigation (Enter / Space on buttons)
    expect(classifyKeyDown(ev({ key: 'Enter', code: 'Enter' }), ctx(), false).kind).toBe('pass');
  });

  it('macOS: Option+key types a character in the search box; ⌘ combinations are looked up', () => {
    setPlatformForTests(true);
    const t = ctx({ textField: true });
    expect(classifyKeyDown(ev({ key: '¬', altKey: true }), t, true).kind).toBe('pass');
    expect(classifyKeyDown(ev({ key: '¬', altKey: true, metaKey: true }), t, true)).toEqual({ kind: 'stroke', stroke: 'ctrl+alt+l' });
    expect(classifyKeyDown(ev({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), t, true).kind).toBe('pass');
    expect(classifyKeyDown(ev({ key: '¬', altKey: true }), ctx(), true)).toEqual({ kind: 'stroke', stroke: 'alt+l' });
  });

  it('recording and a pending chord look up plain keys too', () => {
    setPlatformForTests(false);
    expect(classifyKeyDown(ev({ key: 'Delete', code: 'Delete' }), ctx({ textField: true, recording: true }), false)).toEqual({ kind: 'stroke', stroke: 'delete' });
    expect(classifyKeyDown(ev({ key: 's', code: 'KeyS' }), ctx({ textField: true, chordPending: true }), false)).toEqual({ kind: 'stroke', stroke: 's' });
    expect(classifyKeyDown(ev({ key: 'Escape', code: 'Escape' }), ctx({ recording: true }), false).kind).toBe('pass');
  });

  it('matches exact modifier sets, strokes and two-step chords', () => {
    const b = [
      { key: 'ctrl+alt+l', commandId: 'fmt' }, { key: 'shift+alt+f', commandId: 'fmt' }, { key: 'ctrl+alt+shift+t', commandId: 'x' },
      { key: 'ctrl+k ctrl+s', commandId: 'sheet' }, { key: 'ctrl+k', commandId: 'k' }, { key: 'f1', commandId: 'sheet' },
    ];
    expect(bindingsWithModifiers(b, 'ctrl+alt').map((x) => x.key)).toEqual(['ctrl+alt+l']);
    expect(bindingsWithModifiers(b, 'ctrl').map((x) => x.key)).toEqual(['ctrl+k ctrl+s', 'ctrl+k']);
    expect(bindingsWithModifiers(b, '')).toEqual([]);
    expect(searchStroke(b, 'ctrl+alt+l', null)).toMatchObject({ key: 'ctrl+alt+l', exact: [{ commandId: 'fmt' }], chords: [] });
    const first = searchStroke(b, 'ctrl+k', null);
    expect(first.exact.map((x) => x.commandId)).toEqual(['k']);
    expect(first.chords.map((x) => x.key)).toEqual(['ctrl+k ctrl+s']);
    expect(searchStroke(b, 'ctrl+s', 'ctrl+k')).toMatchObject({ key: 'ctrl+k ctrl+s', exact: [{ commandId: 'sheet' }] });
    // a second stroke that completes no chord is looked up on its own
    expect(searchStroke(b, 'f1', 'ctrl+k')).toMatchObject({ key: 'f1', exact: [{ commandId: 'sheet' }] });
  });

  it('speaks keys in words on both platforms', () => {
    expect(spokenShortcut('ctrl+alt', false)).toBe('Ctrl + Alt');
    expect(spokenShortcut('ctrl+alt+shift+l', false)).toBe('Ctrl + Shift + Alt + L');
    expect(spokenShortcut('ctrl+k ctrl+s', false)).toBe('Ctrl + K, then Ctrl + S');
    expect(spokenShortcut('ctrl+alt+l', true)).toBe('Option + Command + L');
    expect(hintAnnouncement(12, 'ctrl+alt', false)).toBe('12 shortcuts use Ctrl + Alt');
    expect(hintAnnouncement(1, 'alt', false)).toBe('1 shortcut uses Alt');
    expect(hintAnnouncement(0, 'ctrl+alt+shift', false)).toBe('No shortcut uses Ctrl + Shift + Alt');
  });
});

describe('ShortcutSheet key search', () => {
  const ran = vi.fn();
  const cmds: Command[] = [
    { id: 't.format', title: 'Format SQL', category: 'Edit', shortcut: 'Shift+Alt+F', altShortcuts: ['Mod+Alt+L'], run: () => ran('format') },
    { id: 't.commit', title: 'Commit transaction', category: 'Transaction', shortcut: 'Mod+Alt+C', run: () => ran('commit') },
    { id: 't.palette', title: 'Command palette…', category: 'View', shortcut: 'Mod+Shift+P', run: () => ran('palette') },
    { id: 't.sheet', title: 'Keyboard shortcuts', category: 'Help', shortcut: 'F1', altShortcuts: ['Mod+K Mod+S'], run: () => ran('sheet') },
    { id: 't.delete', title: 'Delete rows', category: 'Data', shortcut: 'Delete', scope: 'grid', run: () => ran('delete') },
  ];
  let uninstall: () => void = () => {};
  let off: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    setPlatformForTests(false);
    resetCommandsForTests();
    off = registerCommands(cmds as Command<never>[]);
    uninstall = installKeyDispatcher();
    useUi.getState().setShortcutsOpen(true);
    render(<ShortcutSheet />);
  });
  afterEach(() => {
    act(() => useUi.getState().setShortcutsOpen(false));
    uninstall();
    off();
    ran.mockReset();
    setPlatformForTests(null);
    vi.useRealTimers();
  });

  const search = () => screen.getByRole('textbox', { name: 'Search shortcuts' });
  const row = (id: string) => document.querySelector(`.sheet-row[data-command="${id}"]`)!;
  const status = () => screen.getByRole('status');
  const body = () => document.querySelector('.sheet-body')!;
  const settle = () => act(() => void vi.advanceTimersByTime(HINT_DELAY_MS + 10));
  const holdCtrlAlt = (target: Element = search()) => {
    fireEvent.keyDown(target, { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    fireEvent.keyDown(target, { key: 'Alt', code: 'AltLeft', ctrlKey: true, altKey: true });
    settle();
  };
  const releaseAll = (target: Element = search()) => {
    fireEvent.keyUp(target, { key: 'Alt', code: 'AltLeft', ctrlKey: true });
    fireEvent.keyUp(target, { key: 'Control', code: 'ControlLeft' });
  };

  it('holding Ctrl+Alt highlights the shortcuts that use exactly Ctrl+Alt, dims the rest, and announces the count', () => {
    expect(search()).toHaveFocus();
    holdCtrlAlt();
    expect(body()).toHaveClass('is-hinting');
    expect(row('t.format')).toHaveClass('is-hint');
    expect(row('t.commit')).toHaveClass('is-hint');
    expect(row('t.palette')).not.toHaveClass('is-hint');
    // only the matching binding of a row is hinted (Format SQL: Ctrl+Alt+L, not Shift+Alt+F)
    const fmt = row('t.format').querySelectorAll('.sheet-binding');
    expect(fmt[0]).not.toHaveClass('is-hint');
    expect(fmt[1]).toHaveClass('is-hint');
    expect(status()).toHaveTextContent('2 shortcuts use Ctrl + Alt');
    expect(document.querySelector('.sheet-keys')).toHaveTextContent(/Ctrl\s*\+\s*Alt\s*\+\s*…\s*2 shortcuts/);
    // releasing restores the normal list at once
    releaseAll();
    expect(body()).not.toHaveClass('is-hinting');
    expect(document.querySelector('.is-hint')).toBeNull();
    expect(document.querySelector('.sheet-keys')).toHaveTextContent(/Hold Ctrl, Alt or Shift/);
  });

  it('pressing a combination selects and scrolls to its command without running it or reaching the dispatcher', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    holdCtrlAlt();
    const press = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
    expect(ran).not.toHaveBeenCalled();
    expect(row('t.format')).toHaveClass('is-selected');
    expect(row('t.format').querySelectorAll('.sheet-binding')[1]).toHaveClass('is-selected');
    expect(scroll).toHaveBeenCalled();
    expect(status()).toHaveTextContent('Ctrl + Alt + L: Format SQL');
    // the selection stays after the keys are released
    releaseAll();
    expect(row('t.format')).toHaveClass('is-selected');
    expect(body()).not.toHaveClass('is-hinting');
    scroll.mockRestore();
  });

  it('an unknown combination says so; F-keys and browser keys are swallowed, not run', () => {
    const f1 = new KeyboardEvent('keydown', { key: 'F1', code: 'F1', bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(f1));
    expect(f1.defaultPrevented).toBe(true);
    expect(ran).not.toHaveBeenCalled();
    expect(row('t.sheet')).toHaveClass('is-selected');
    fireEvent.keyDown(search(), { key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(status()).toHaveTextContent('No shortcut uses Ctrl + Alt + Q');
    expect(document.querySelector('.sheet-row.is-selected')).toBeNull();
  });

  it('is not bypassed when focus left the dialog (the global dispatcher would otherwise run the command)', () => {
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true });
    expect(ran).not.toHaveBeenCalled();
    expect(row('t.commit')).toHaveClass('is-selected');
  });

  it('chords are a two-step search: Ctrl+K waits, Ctrl+S selects the chord', () => {
    fireEvent.keyDown(search(), { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(status()).toHaveTextContent('Ctrl + K: 1 chord, press the second key');
    expect(row('t.sheet')).toHaveClass('is-hint');
    expect(document.querySelector('.sheet-keys')).toHaveTextContent(/press the second key/);
    fireEvent.keyDown(search(), { key: 's', code: 'KeyS', ctrlKey: true });
    expect(ran).not.toHaveBeenCalled();
    expect(row('t.sheet')).toHaveClass('is-selected');
    expect(status()).toHaveTextContent('Ctrl + K, then Ctrl + S: Keyboard shortcuts');
  });

  it('Escape cancels a pending chord first, then closes the sheet', () => {
    fireEvent.keyDown(search(), { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(search(), { key: 'Escape', code: 'Escape' });
    expect(useUi.getState().shortcutsOpen).toBe(true);
    expect(status()).toHaveTextContent('Chord cancelled');
    fireEvent.keyDown(search(), { key: 'Escape', code: 'Escape' });
    expect(useUi.getState().shortcutsOpen).toBe(false);
  });

  it('typing in the search box works normally: letters, Shift and editing keys are not taken', () => {
    const shift = new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft', shiftKey: true, bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(shift));
    settle();
    expect(body()).not.toHaveClass('is-hinting');
    const selectAll = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(selectAll));
    expect(selectAll.defaultPrevented).toBe(false);
    const letter = new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(letter));
    expect(letter.defaultPrevented).toBe(false);
    fireEvent.change(search(), { target: { value: 'commit' } });
    expect(document.querySelectorAll('.sheet-row')).toHaveLength(1);
    // outside the text box Shift alone hints
    const toggle = screen.getByRole('button', { name: 'Record keys' });
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    settle();
    expect(status()).toHaveTextContent('No shortcut uses Shift');
  });

  it('a combination whose command the text filter hides clears the filter so the match is shown', () => {
    fireEvent.change(search(), { target: { value: 'commit' } });
    fireEvent.keyDown(search(), { key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true });
    expect(search()).toHaveValue('');
    expect(row('t.palette')).toHaveClass('is-selected');
  });

  it('AltGr (reported as Ctrl+Alt) neither hints nor searches; its characters are typed', () => {
    fireEvent.keyDown(search(), { key: 'Control', code: 'ControlLeft', ctrlKey: true });
    fireEvent.keyDown(search(), { key: 'AltGraph', code: 'AltRight', ctrlKey: true, altKey: true });
    settle();
    expect(body()).not.toHaveClass('is-hinting');
    const ch = new KeyboardEvent('keydown', { key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(ch));
    expect(ch.defaultPrevented).toBe(false);
    expect(document.querySelector('.sheet-row.is-selected')).toBeNull();
    // even a key whose character equals the bare key is not a shortcut while AltGr is down
    const same = new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(same));
    expect(same.defaultPrevented).toBe(false);
    fireEvent.keyUp(search(), { key: 'AltGraph', code: 'AltRight', ctrlKey: true });
    fireEvent.keyUp(search(), { key: 'Control', code: 'ControlLeft' });
    // after AltGr is released, a real Ctrl+Alt works again
    holdCtrlAlt();
    expect(body()).toHaveClass('is-hinting');
  });

  it('Record keys looks up plain keys too; Escape stops recording before it closes', () => {
    const toggle = screen.getByRole('button', { name: 'Record keys' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    search().focus();
    const del = new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true, cancelable: true });
    act(() => void search().dispatchEvent(del));
    expect(del.defaultPrevented).toBe(true);
    expect(row('t.delete')).toHaveClass('is-selected');
    fireEvent.keyDown(search(), { key: 'Escape', code: 'Escape' });
    expect(useUi.getState().shortcutsOpen).toBe(true);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('ShortcutSheet on macOS', () => {
  afterEach(() => {
    act(() => useUi.getState().setShortcutsOpen(false));
    setPlatformForTests(null);
    vi.useRealTimers();
  });

  it('shows the held keys as ⌘⌥ caps and speaks them in words', () => {
    vi.useFakeTimers();
    setPlatformForTests(true);
    resetCommandsForTests();
    const off = registerCommands([{ id: 't.format', title: 'Format SQL', category: 'Edit', shortcut: 'Mod+Alt+L', run: () => {} }]);
    const uninstall = installKeyDispatcher();
    useUi.getState().setShortcutsOpen(true);
    render(<ShortcutSheet />);
    const input = screen.getByRole('textbox', { name: 'Search shortcuts' });
    fireEvent.keyDown(input, { key: 'Meta', code: 'MetaLeft', metaKey: true });
    fireEvent.keyDown(input, { key: 'Alt', code: 'AltLeft', metaKey: true, altKey: true });
    act(() => void vi.advanceTimersByTime(HINT_DELAY_MS + 10));
    const caps = [...document.querySelectorAll('.sheet-keys kbd')].map((k) => k.textContent);
    expect(caps).toEqual(['⌥', '⌘']);
    expect(document.querySelector('.sheet-keys')).not.toHaveTextContent('+');
    expect(screen.getByRole('status')).toHaveTextContent('1 shortcut uses Option + Command');
    uninstall();
    off();
  });
});
