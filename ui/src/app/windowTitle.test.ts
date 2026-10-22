import { describe, expect, it } from 'vitest';
import { windowTitle } from './windowTitle';

describe('window title', () => {
  it('appends the connection to a tab title that does not name it', () => {
    expect(windowTitle('Console 1', 'Prod SQL')).toBe('Console 1 — Prod SQL — Rowlit');
    expect(windowTitle('dbo.Customers', 'Prod SQL')).toBe('dbo.Customers — Prod SQL — Rowlit');
  });

  it('never repeats a connection the tab title already names', () => {
    expect(windowTitle('Logs & activity — Prod SQL', 'Prod SQL')).toBe('Logs & activity — Prod SQL — Rowlit');
    expect(windowTitle('Cache · db0', 'Cache')).toBe('Cache · db0 — Rowlit');
    expect(windowTitle('Events · Overview', 'Events')).toBe('Events · Overview — Rowlit');
    expect(windowTitle('ER: Shop', 'Shop')).toBe('ER: Shop — Rowlit');
    expect(windowTitle('ER: Shop.sales', 'Shop')).toBe('ER: Shop.sales — Rowlit');
  });

  it('only matches whole parts of the title', () => {
    expect(windowTitle('Shopping list', 'Shop')).toBe('Shopping list — Shop — Rowlit');
    expect(windowTitle('ER: Shopify.main', 'Shop')).toBe('ER: Shopify.main — Shop — Rowlit');
  });

  it('works without a tab or a connection', () => {
    expect(windowTitle(null, null)).toBe('Rowlit');
    expect(windowTitle('Welcome', null)).toBe('Welcome — Rowlit');
    expect(windowTitle(undefined, 'Prod')).toBe('Prod — Rowlit');
  });
});
