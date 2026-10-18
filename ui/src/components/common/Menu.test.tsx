// design-r2-02: a menu opened from the keyboard keeps its first-item selection when the browser fires mouseenter on
// the item that appears under a pointer that has not moved; hover works again after a real mouse move.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MenuHost, useMenu, type MenuItem } from './Menu';

const items = (): MenuItem[] => [
  { id: 'copy', label: 'Copy' },
  { id: 'paste', label: 'Paste' },
  { separator: true },
  { id: 'edit', label: 'Edit cell' },
  { id: 'filter', label: 'Filter', submenu: [{ id: 'eq', label: 'Equals' }, { id: 'ne', label: 'Not equal' }] },
];

afterEach(() => act(() => useMenu.getState().hide()));

describe('Menu pointer guard (design-r2-02)', () => {
  it('a keyboard-opened menu ignores mouseenter until the pointer moves', () => {
    render(<MenuHost />);
    act(() => useMenu.getState().show(10, 10, items(), { fromKeyboard: true }));
    const menu = screen.getByRole('menu');
    const first = screen.getByRole('menuitem', { name: 'Copy' });
    const filter = screen.getByRole('menuitem', { name: 'Filter' });
    expect(menu).toHaveAttribute('aria-activedescendant', first.id);

    // The menu appeared under a still pointer: Chromium fires mouseenter on the item below it.
    fireEvent.mouseEnter(filter);
    expect(menu).toHaveAttribute('aria-activedescendant', first.id);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    // So the next key still acts from the first item.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(menu).toHaveAttribute('aria-activedescendant', screen.getByRole('menuitem', { name: 'Paste' }).id);

    // A real move over the menu hands it back to the mouse: the item under the pointer becomes active at once.
    fireEvent.mouseMove(filter, { clientX: 40, clientY: 60 });
    expect(menu).toHaveAttribute('aria-activedescendant', filter.id);
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Edit cell' }));
    expect(menu).toHaveAttribute('aria-activedescendant', screen.getByRole('menuitem', { name: 'Edit cell' }).id);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('a mousemove at the coordinates the pointer had when the menu opened does not count as a move', () => {
    render(<MenuHost />);
    // the pointer rests at (470, 680) when Shift+F10 is pressed
    fireEvent.mouseMove(window, { clientX: 470, clientY: 680 });
    act(() => useMenu.getState().show(10, 10, items(), { fromKeyboard: true }));
    const menu = screen.getByRole('menu');
    const first = screen.getByRole('menuitem', { name: 'Copy' });
    const filter = screen.getByRole('menuitem', { name: 'Filter' });
    fireEvent.mouseMove(filter, { clientX: 470, clientY: 680 });
    fireEvent.mouseEnter(filter);
    expect(menu).toHaveAttribute('aria-activedescendant', first.id);
    fireEvent.mouseMove(filter, { clientX: 471, clientY: 680 });
    expect(menu).toHaveAttribute('aria-activedescendant', filter.id);
  });

  it('a mouse-opened menu follows hover right away, and every open starts a new guard', () => {
    render(<MenuHost />);
    act(() => useMenu.getState().show(10, 10, items(), { fromKeyboard: false }));
    let menu = screen.getByRole('menu');
    expect(menu).not.toHaveAttribute('aria-activedescendant');
    const paste = screen.getByRole('menuitem', { name: 'Paste' });
    fireEvent.mouseEnter(paste);
    expect(menu).toHaveAttribute('aria-activedescendant', paste.id);

    act(() => useMenu.getState().show(10, 10, items(), { fromKeyboard: true }));
    menu = screen.getByRole('menu');
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Paste' }));
    expect(menu).toHaveAttribute('aria-activedescendant', screen.getByRole('menuitem', { name: 'Copy' }).id);
  });

  it('a submenu opened from the keyboard is guarded too', () => {
    render(<MenuHost />);
    act(() => useMenu.getState().show(10, 10, items(), { fromKeyboard: false }));
    const menu = screen.getByRole('menu');
    const filter = screen.getByRole('menuitem', { name: 'Filter' });
    fireEvent.mouseEnter(filter);
    fireEvent.keyDown(menu, { key: 'ArrowRight' });
    const sub = screen.getAllByRole('menu')[1];
    const equals = screen.getByRole('menuitem', { name: 'Equals' });
    expect(sub).toHaveAttribute('aria-activedescendant', equals.id);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Not equal' }));
    expect(sub).toHaveAttribute('aria-activedescendant', equals.id);
  });
});
