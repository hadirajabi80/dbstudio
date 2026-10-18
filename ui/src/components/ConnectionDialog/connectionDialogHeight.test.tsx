// design-19: switching provider never moves the footer. Every provider pane renders inside the one .conn-dialog-layout
// whose min-height (layout.css) fits the tallest form, Oracle's (592 px measured in the browser at 1440x900); the
// dialog body keeps scrolling on a short viewport. jsdom has no layout, so the height is asserted on the stylesheet.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useConnections } from '../../store/connections';
import { installMockEngine } from '../../test/mockServer';
import { ConnectionDialog } from './ConnectionDialog';

/** Height of the Oracle form (the tallest provider pane), measured with the real stylesheet. */
const ORACLE_FORM_PX = 592;

// Node API, typed locally (the app tsconfig has no Node types; vitest runs on Node).
const fs = (await import(/* @vite-ignore */ `node:${'fs'}`)) as { readFileSync(p: string, enc: 'utf8'): string };
const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
const read = (p: string) => fs.readFileSync(`${cwd}/src/${p}`, 'utf8');

/** Body of the top-level rule with exactly this selector. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] ?? '';
}
const px = (body: string, prop: string) => Number(new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(body)?.[1] ?? NaN);

const mock = installMockEngine();

describe('connection dialog height (design-19)', () => {
  beforeEach(async () => {
    mock.reset();
    useConnections.setState({ providers: [], connections: [], loaded: false, error: null });
    await useConnections.getState().load();
  });

  it('reserves the Oracle form height for every provider, and the body still scrolls', () => {
    const min = px(rule(read('components/layout/layout.css'), '.conn-dialog .conn-dialog-layout'), 'min-height');
    expect(min).toBeGreaterThanOrEqual(ORACLE_FORM_PX);
    const app = read('theme/app.css');
    expect(rule(app, '.dialog-body')).toMatch(/overflow: auto;/);
    expect(rule(app, '.dialog-body')).toMatch(/min-height: 0;/);
    expect(rule(app, '.dialog')).toMatch(/max-height: calc\(100vh - \d+px\);/);
  });

  it('renders every provider pane inside the same min-height layout (no per-provider sizing)', async () => {
    const user = userEvent.setup();
    const { container } = render(<ConnectionDialog state={{ mode: 'new', providerId: 'sqlserver' }} onClose={() => {}} />);
    const layout = container.ownerDocument.querySelector('.conn-dialog-layout')!;
    expect(layout).not.toBeNull();
    const seen: string[] = [];
    for (const name of [/SQL Server/, /Oracle/, /SQLite/]) {
      await user.click(screen.getByRole('option', { name }));
      const now = container.ownerDocument.querySelector('.conn-dialog-layout')!;
      // same element (the pane is swapped inside it), same class list, no inline height
      expect(now).toBe(layout);
      expect(now.className).toBe('conn-dialog-layout');
      expect((now as HTMLElement).style.height + (now as HTMLElement).style.minHeight).toBe('');
      expect(now.querySelector('.conn-form .form-grid')).not.toBeNull();
      seen.push(now.closest('.dialog-body') ? 'in body' : 'outside');
    }
    expect(seen).toEqual(['in body', 'in body', 'in body']);
  });
});
