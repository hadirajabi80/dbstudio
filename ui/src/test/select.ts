// Test helpers for the custom Select (components/common/Select.tsx): it renders a combobox button and, while open,
// a portaled listbox, so tests pick options the way a user does instead of firing `change` on a native <select>.
import { fireEvent, screen } from '@testing-library/react';

/** Current value of a Select trigger (its data-value). */
export function selectValue(trigger: HTMLElement): string {
  return trigger.getAttribute('data-value') ?? '';
}

/** Open the Select and click the option with this accessible name, or (`{ value }`) this value. */
export function chooseOption(trigger: HTMLElement, option: string | RegExp | { value: string | number }): void {
  if (trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger);
  const opts = screen.getAllByRole('option');
  const el = typeof option === 'object' && !(option instanceof RegExp)
    ? opts.find((o) => o.getAttribute('data-value') === String(option.value))
    : screen.getByRole('option', { name: option });
  if (!el) throw new Error(`no option ${JSON.stringify(option)}`);
  fireEvent.click(el);
}

/** Values of every option of a Select (opens it, reads the list, closes it with Esc). */
export function optionValues(trigger: HTMLElement): string[] {
  const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
  if (!wasOpen) fireEvent.click(trigger);
  const id = trigger.getAttribute('aria-controls');
  const list = id ? document.getElementById(id) : null;
  const values = [...(list ?? document).querySelectorAll('[role=option]')].map((o) => o.getAttribute('data-value') ?? '');
  if (!wasOpen) fireEvent.keyDown(trigger, { key: 'Escape' });
  return values;
}
