// user-04: the styled Select that replaces every native <select>: ARIA select-only combobox semantics, full keyboard
// support (arrows, Home/End, PageUp/PageDown, Enter, Space, Esc, Tab, Alt+Up, type-ahead), a filter box for long
// lists, portal positioning that flips at the viewport edge, and good manners inside modal dialogs.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import { Select } from './Select';
import { filterOptions, SEARCH_THRESHOLD, type SelectOption } from './selectModel';

const ROWS: SelectOption<number>[] = [
  { value: 500, label: '500' },
  { value: 1000, label: '1,000' },
  { value: 10000, label: '10,000' },
  { value: 100000, label: '100,000' },
  { value: 0, label: 'No limit' },
];

function Rows({ onChange = () => {}, initial = 1000, disabled = false }: { onChange?: (v: number) => void; initial?: number; disabled?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <label htmlFor="rows">Max rows</label>
      <Select
        id="rows"
        value={v}
        options={ROWS}
        disabled={disabled}
        onChange={(n) => {
          setV(n);
          onChange(n);
        }}
      />
    </>
  );
}

const trigger = () => screen.getByRole('combobox', { name: 'Max rows' });
const key = (el: Element, k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(el, { key: k, ...init });
const activeOption = (owner: HTMLElement = trigger()) => {
  const id = owner.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
};

describe('Select (user-04)', () => {
  it('is a labelled combobox button that shows the selected label', () => {
    render(<Rows />);
    const t = trigger();
    expect(t.tagName).toBe('BUTTON');
    expect(t).toHaveAttribute('aria-haspopup', 'listbox');
    expect(t).toHaveAttribute('aria-expanded', 'false');
    expect(t).toHaveTextContent('1,000');
    expect(t).toHaveAttribute('data-value', '1000');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on click: a listbox of options, the selected one marked and active', () => {
    render(<Rows />);
    fireEvent.click(trigger());
    // the list is named like the field (from its <label>)
    const list = screen.getByRole('listbox', { name: 'Max rows' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(trigger()).toHaveAttribute('aria-controls', list.id);
    const opts = screen.getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['500', '1,000', '10,000', '100,000', 'No limit']);
    expect(opts[1]).toHaveAttribute('aria-selected', 'true');
    expect(opts[0]).toHaveAttribute('aria-selected', 'false');
    expect(activeOption()).toBe(opts[1]);
    // rendered in a portal (not clipped by toolbars with overflow: hidden)
    expect(list.closest('.select-pop')?.parentElement).toBe(document.body);
  });

  it('picks with the mouse and closes', () => {
    const onChange = vi.fn();
    render(<Rows onChange={onChange} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole('option', { name: 'No limit' }));
    expect(onChange).toHaveBeenCalledWith(0);
    expect(trigger()).toHaveTextContent('No limit');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keyboard: ArrowDown opens, arrows move, Enter picks and focus stays on the trigger', () => {
    const onChange = vi.fn();
    render(<Rows onChange={onChange} />);
    const t = trigger();
    t.focus();
    key(t, 'ArrowDown');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(activeOption()).toHaveTextContent('1,000'); // opening never changes the value
    expect(onChange).not.toHaveBeenCalled();
    key(t, 'ArrowDown');
    key(t, 'ArrowDown');
    expect(activeOption()).toHaveTextContent('100,000');
    key(t, 'ArrowUp');
    expect(activeOption()).toHaveTextContent('10,000');
    key(t, 'Enter');
    expect(onChange).toHaveBeenCalledWith(10000);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(t);
  });

  it('keyboard: Home / End / PageDown, no wrap at the ends, Space picks', () => {
    const onChange = vi.fn();
    render(<Rows onChange={onChange} />);
    const t = trigger();
    key(t, 'End');
    expect(activeOption()).toHaveTextContent('No limit');
    key(t, 'ArrowDown');
    expect(activeOption()).toHaveTextContent('No limit');
    key(t, 'Home');
    expect(activeOption()).toHaveTextContent('500');
    key(t, 'ArrowUp');
    expect(activeOption()).toHaveTextContent('500');
    key(t, 'PageDown');
    expect(activeOption()).toHaveTextContent('No limit');
    key(t, ' ');
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('keyboard: Alt+ArrowUp and Tab pick the active option; Esc closes without a change', () => {
    const onChange = vi.fn();
    render(<Rows onChange={onChange} />);
    const t = trigger();
    key(t, 'ArrowDown');
    key(t, 'ArrowDown');
    key(t, 'Escape');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    key(t, 'ArrowDown', { altKey: true });
    key(t, 'ArrowDown');
    key(t, 'ArrowUp', { altKey: true });
    expect(onChange).toHaveBeenLastCalledWith(10000);
    key(t, 'ArrowDown');
    key(t, 'ArrowDown');
    key(t, 'Tab');
    expect(onChange).toHaveBeenLastCalledWith(100000);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('type-ahead: a character opens on the first match; typed prefixes and repeats refine it', () => {
    const fruit = ['Apple', 'Banana', 'Blueberry', 'Cherry'].map((f) => ({ value: f, label: f }));
    function Fruit() {
      const [v, setV] = useState('Apple');
      return <Select aria-label="Fruit" value={v} options={fruit} onChange={setV} />;
    }
    render(<Fruit />);
    const t = screen.getByRole('combobox', { name: 'Fruit' });
    key(t, 'b');
    expect(activeOption(t)).toHaveTextContent('Banana');
    key(t, 'l');
    expect(activeOption(t)).toHaveTextContent('Blueberry');
    key(t, 'Enter');
    expect(t).toHaveTextContent('Blueberry');
  });

  it('skips disabled options with the keyboard and ignores clicks on them', () => {
    const onChange = vi.fn();
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }, { value: 'c', label: 'C' }];
    render(<Select aria-label="Letters" value="a" options={opts} onChange={onChange} />);
    const t = screen.getByRole('combobox', { name: 'Letters' });
    key(t, 'ArrowDown');
    key(t, 'ArrowDown');
    expect(activeOption(t)).toHaveTextContent('C');
    expect(screen.getByRole('option', { name: 'B' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('option', { name: 'B' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a disabled Select never opens', () => {
    render(<Rows disabled />);
    expect(trigger()).toBeDisabled();
    key(trigger(), 'ArrowDown');
    fireEvent.click(trigger());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on a click outside', () => {
    render(<Rows />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the placeholder when the value matches no option', () => {
    render(<Select aria-label="Column" value={-1} placeholder="Total (missing)" options={[{ value: 0, label: 'Id' }]} onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Column' })).toHaveTextContent('Total (missing)');
  });

  it('groups options under headings (ARIA groups)', () => {
    const opts = [
      { value: '', label: '(choose a table)' },
      { value: 't1', label: 'Orders', group: 'Tables' },
      { value: 'v1', label: 'OrderView', group: 'Views' },
    ];
    render(<Select aria-label="Table" value="" options={opts} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Table' }));
    expect(screen.getByRole('group', { name: 'Tables' })).toHaveTextContent('Orders');
    expect(screen.getByRole('group', { name: 'Views' })).toHaveTextContent('OrderView');
  });

  describe('long lists get a filter box', () => {
    const TYPES = ['bigint', 'binary', 'bit', 'char', 'date', 'datetime', 'datetime2', 'decimal', 'float', 'int', 'money', 'nchar', 'nvarchar', 'varchar']
      .map((t) => ({ value: t, label: t }));

    it(`from ${SEARCH_THRESHOLD} options: typing filters, Enter picks the first match`, () => {
      const onChange = vi.fn();
      render(<Select aria-label="Type" value="int" options={TYPES} onChange={onChange} />);
      fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
      const search = screen.getByRole('combobox', { name: 'Filter Type' });
      expect(document.activeElement).toBe(search);
      fireEvent.change(search, { target: { value: 'date' } });
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['date', 'datetime', 'datetime2']);
      expect(activeOption(search)).toHaveTextContent('date');
      key(search, 'ArrowDown');
      expect(activeOption(search)).toHaveTextContent('datetime');
      key(search, 'Enter');
      expect(onChange).toHaveBeenCalledWith('datetime');
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Type' }));
    });

    it('matches inside labels after prefix matches, and says when nothing matches', () => {
      render(<Select aria-label="Type" value="int" options={TYPES} onChange={() => {}} />);
      fireEvent.click(screen.getByRole('combobox', { name: 'Type' }));
      const search = screen.getByRole('combobox', { name: 'Filter Type' });
      fireEvent.change(search, { target: { value: 'char' } });
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['char', 'nchar', 'nvarchar', 'varchar']);
      fireEvent.change(search, { target: { value: 'zzz' } });
      expect(screen.queryAllByRole('option')).toEqual([]);
      expect(screen.getByText('No matches')).toBeInTheDocument();
    });

    it('typing on the closed trigger opens the list already filtered', () => {
      render(<Select aria-label="Type" value="int" options={TYPES} onChange={() => {}} />);
      key(screen.getByRole('combobox', { name: 'Type' }), 'n');
      const search = screen.getByRole('combobox', { name: 'Filter Type' });
      expect(search).toHaveValue('n');
      expect(screen.getAllByRole('option').map((o) => o.textContent).slice(0, 2)).toEqual(['nchar', 'nvarchar']);
      expect(activeOption(search)).toHaveTextContent('nchar');
    });

    it('filterOptions ranks prefix matches first', () => {
      expect(filterOptions(TYPES, 'n').map((o) => o.value).slice(0, 2)).toEqual(['nchar', 'nvarchar']);
      expect(filterOptions(TYPES, '').length).toBe(TYPES.length);
    });
  });

  it('inside a modal dialog: Esc closes only the list, Enter picks without submitting the dialog', () => {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const onChange = vi.fn();
    render(
      <Dialog title="Options" onClose={onClose} onSubmit={onSubmit}>
        <Select aria-label="Mode" value="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={onChange} />
      </Dialog>,
    );
    const t = screen.getByRole('combobox', { name: 'Mode' });
    key(t, 'ArrowDown');
    key(t, 'Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    key(t, 'ArrowDown');
    key(t, 'ArrowDown');
    key(t, 'Enter');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(onSubmit).not.toHaveBeenCalled();
    // closed: Esc belongs to the dialog again
    key(t, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe('positioning', () => {
    const rect = (top: number, bottom: number) => ({ left: 100, right: 220, top, bottom, width: 120, height: bottom - top, x: 100, y: top, toJSON() {} }) as DOMRect;

    it('opens below the trigger, at least as wide as it', async () => {
      render(<Rows />);
      vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(rect(40, 68));
      await act(async () => {
        fireEvent.click(trigger());
      });
      const pop = document.querySelector<HTMLElement>('.select-pop')!;
      expect(pop.classList.contains('above')).toBe(false);
      expect(pop.style.top).toBe('72px');
      expect(pop.style.left).toBe('100px');
      expect(pop.style.minWidth).toBe('120px');
    });

    it('flips above the trigger at the bottom edge of the window', async () => {
      render(<Rows />);
      vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue(rect(window.innerHeight - 30, window.innerHeight - 2));
      await act(async () => {
        fireEvent.click(trigger());
      });
      expect(document.querySelector('.select-pop')!.classList.contains('above')).toBe(true);
    });
  });
});
