// Common shell parts (B4): dialogs focus their first field in document order, the custom Select included
// (styles-r1-04); deliberate icon stroke widths opt out of the global 1.5 rule (styles-r1-02).
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';
import { ColumnIcon, ProviderIcon } from './icons';
import { Select } from './Select';

function SettingsLike() {
  const [theme, setTheme] = useState('system');
  return (
    <Dialog title="Settings" onClose={() => {}} footer={<button className="btn btn-primary">Save</button>}>
      <label htmlFor="theme">Theme</label>
      <Select id="theme" value={theme} options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }]} onChange={setTheme} />
      <label><input type="checkbox" /> Confirm statements that modify data</label>
      <input aria-label="Font size" />
    </Dialog>
  );
}

describe('Dialog initial focus (styles-r1-04)', () => {
  it('focuses the first field even when it is a custom Select (button[role=combobox])', () => {
    render(<SettingsLike />);
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Theme' }));
  });

  it('keeps document order: an input before the Select wins', () => {
    render(
      <Dialog title="Params" onClose={() => {}}>
        <input aria-label="Name" />
        <Select aria-label="Kind" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
  });

  it('skips a disabled Select and still honours [data-autofocus]', () => {
    const { unmount } = render(
      <Dialog title="Disabled" onClose={() => {}}>
        <Select aria-label="Kind" disabled value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
        <input aria-label="Value" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Value'));
    unmount();
    render(
      <Dialog title="Confirm" onClose={() => {}} footer={<button className="btn" data-autofocus>Cancel</button>}>
        <Select aria-label="Kind" value="a" options={[{ value: 'a', label: 'A' }]} onChange={() => {}} />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });
});

describe('icon stroke opt-outs (styles-r1-02)', () => {
  it('draws the PK/FK badge at 2.5 and the provider glyph at 2, marked data-stroke so the 1.5 default skips them', () => {
    const { container } = render(<><ColumnIcon pk /><ColumnIcon fk /><ProviderIcon providerId="sqlite" /></>);
    const badges = container.querySelectorAll('svg.col-badge');
    expect(badges).toHaveLength(2);
    for (const b of badges) {
      expect(b).toHaveAttribute('data-stroke');
      expect(b).toHaveAttribute('stroke-width', '2.5');
    }
    const glyph = container.querySelector('.provider-icon svg')!;
    expect(glyph).toHaveAttribute('data-stroke');
    expect(glyph).toHaveAttribute('stroke-width', '2');
    // ordinary icons keep the default (no opt-out)
    expect(container.querySelector('svg.obj-column')).not.toHaveAttribute('data-stroke');
  });

  it('draws the Select check mark at 2', () => {
    render(<Select aria-label="Kind" value="a" options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Kind' }));
    const check = document.querySelector('.select-check svg')!;
    expect(check).toHaveAttribute('data-stroke');
    expect(check).toHaveAttribute('stroke-width', '2');
  });

  it('renders a leading icon inside the trigger, hidden from assistive tech', () => {
    render(<Select aria-label="Max rows" value="a" options={[{ value: 'a', label: '10,000' }]} onChange={() => {}} leadingIcon={<svg data-testid="lead" />} />);
    const trigger = screen.getByRole('combobox', { name: 'Max rows' });
    const lead = screen.getByTestId('lead').parentElement!;
    expect(lead).toHaveClass('select-lead');
    expect(lead).toHaveAttribute('aria-hidden', 'true');
    expect(trigger).toContainElement(lead);
  });
});
