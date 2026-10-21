import { describe, expect, it } from 'vitest';
import { windowTitle } from './windowTitle';

describe('window title', () => {
  it('appends the connection to a tab title that does not name it', () => {
    expect(windowTitle('Console 1', 'Prod SQL')).toBe('Console 1 — Prod SQL — DbStudio');
    expect(windowTitle('dbo.Customers', 'Prod SQL')).toBe('dbo.Customers — Prod SQL — DbStudio');
  });

  it('never repeats a connection the tab title already names', () => {
    expect(windowTitle('Logs & activity — Prod SQL', 'Prod SQL')).toBe('Logs & activity — Prod SQL — DbStudio');
    expect(windowTitle('Cache · db0', 'Cache')).toBe('Cache · db0 — DbStudio');
    expect(windowTitle('Events · Overview', 'Events')).toBe('Events · Overview — DbStudio');
    expect(windowTitle('ER: Shop', 'Shop')).toBe('ER: Shop — DbStudio');
    expect(windowTitle('ER: Shop.sales', 'Shop')).toBe('ER: Shop.sales — DbStudio');
  });

  it('only matches whole parts of the title', () => {
    expect(windowTitle('Shopping list', 'Shop')).toBe('Shopping list — Shop — DbStudio');
    expect(windowTitle('ER: Shopify.main', 'Shop')).toBe('ER: Shopify.main — Shop — DbStudio');
  });

  it('works without a tab or a connection', () => {
    expect(windowTitle(null, null)).toBe('DbStudio');
    expect(windowTitle('Welcome', null)).toBe('Welcome — DbStudio');
    expect(windowTitle(undefined, 'Prod')).toBe('Prod — DbStudio');
  });
});
