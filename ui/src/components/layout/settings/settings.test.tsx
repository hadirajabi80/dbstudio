// Settings dialog: one size for every section (Snippets used to widen it), icon nav, search across sections, and the
// Appearance pickers writing the theme settings (settings.theme stays the mode; the themes live in settings.ui).
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, useSettings } from '../../../store/settings';
import { useUi } from '../../../store/ui';
import { APP_THEME_DARK_KEY, APP_THEME_LIGHT_KEY, EDITOR_THEME_KEY } from '../../../theme/themes';
import { SettingsDialog as LazySettingsDialog } from '../SettingsDialog';
import { SettingsDialog } from './SettingsDialog';
import { openSettings, useSettingsNav } from './nav';

let update: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true });
  useSettingsNav.setState({ section: 'general' });
  useUi.setState({ settingsOpen: true });
  update = vi.spyOn(useSettings.getState(), 'update').mockImplementation(() => undefined);
});
afterEach(() => {
  update.mockRestore();
  useUi.setState({ settingsOpen: false });
});

const dialog = () => screen.getByRole('dialog', { name: 'Settings' });

describe('Settings dialog', () => {
  it('loads on first open (App imports a lazy wrapper) and renders nothing while closed', async () => {
    useUi.setState({ settingsOpen: false });
    const { container } = render(<LazySettingsDialog />);
    expect(container).toBeEmptyDOMElement();
    act(() => useUi.setState({ settingsOpen: true }));
    expect(await screen.findByRole('dialog', { name: 'Settings' }, { timeout: 10000 })).toBeInTheDocument();
  });

  it('keeps one size for every section, Snippets included', async () => {
    render(<SettingsDialog />);
    const tabs = within(screen.getByRole('tablist', { name: 'Settings sections' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['General', 'Appearance', 'Editor', 'Results & grid', 'SQL formatting', 'Connections', 'Snippets', 'Updates']);
    const widths = new Set<string>();
    for (const t of tabs) {
      fireEvent.click(t);
      expect(t).toHaveAttribute('aria-selected', 'true');
      widths.add(dialog().style.width);
    }
    expect([...widths]).toEqual(['960px']);
    expect(dialog()).toHaveClass('settings-dialog');
    await act(async () => undefined);
  });

  it('remembers the section and opens on a given one', () => {
    const { unmount } = render(<SettingsDialog />);
    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    unmount();
    render(<SettingsDialog />);
    expect(screen.getByRole('tab', { name: 'Editor' })).toHaveAttribute('aria-selected', 'true');
    act(() => openSettings('updates'));
    expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Updates', level: 2 })).toBeInTheDocument();
  });

  it('search shows the matching rows of every section and hides the rest', () => {
    render(<SettingsDialog />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'font' } });
    expect(screen.getByRole('heading', { name: 'Search results', level: 2 })).toBeInTheDocument();
    expect(screen.getByLabelText('Editor font size')).toBeVisible();
    // rows of other sections are rendered but hidden
    expect(screen.getByText('Tab size').closest('[data-settings-row]')).toHaveAttribute('hidden');
    expect(screen.queryByRole('tab', { selected: true })).toBeNull();
    // Escape clears the search first (the dialog stays open)
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Search settings' }), { key: 'Escape' });
    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toHaveValue('');
    expect(useUi.getState().settingsOpen).toBe(true);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'zzzz nothing' } });
    expect(screen.getByText(/No settings match/)).toBeInTheDocument();
  });

  it('keeps every existing setting (switches are still checkboxes)', () => {
    render(<SettingsDialog />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm statements that modify data' }));
    expect(update).toHaveBeenLastCalledWith({ confirmDestructive: false });
    fireEvent.click(screen.getByRole('tab', { name: 'Editor' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open procedures and functions in edit mode' }));
    expect(update).toHaveBeenLastCalledWith({ ui: { openRoutinesInEditMode: true } });
    fireEvent.click(screen.getByRole('tab', { name: 'Results & grid' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show the SQL before saving edits' }));
    expect(update).toHaveBeenLastCalledWith({ grid: { showSqlBeforeSave: true } });
    fireEvent.click(screen.getByRole('tab', { name: 'SQL formatting' }));
    expect(screen.getByRole('checkbox', { name: 'Indent with tabs' })).not.toBeChecked();
  });
});

describe('Settings › Appearance', () => {
  it('mode, app theme per mode and code theme', () => {
    useSettingsNav.setState({ section: 'appearance' });
    render(<SettingsDialog />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: 'Dark' }));
    expect(update).toHaveBeenLastCalledWith({ theme: 'dark' });

    // "Follow system" (the default): a pick only stores the favourite of that mode
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Dark theme' })).getByRole('radio', { name: /Nord/ }));
    expect(update).toHaveBeenLastCalledWith({ ui: { [APP_THEME_DARK_KEY]: 'nord' } });
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Light theme' })).getByRole('radio', { name: /Paper/ }));
    expect(update).toHaveBeenLastCalledWith({ ui: { [APP_THEME_LIGHT_KEY]: 'paper' } });

    const code = screen.getByRole('radiogroup', { name: 'Code theme' });
    expect(within(code).getByRole('radio', { name: /Match app theme/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(code).getByRole('radio', { name: /Monokai/ }));
    expect(update).toHaveBeenLastCalledWith({ ui: { [EDITOR_THEME_KEY]: 'monokai' } });
  });

  it('an explicit mode follows the pick of the other mode', () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'light' } });
    useSettingsNav.setState({ section: 'appearance' });
    render(<SettingsDialog />);
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Dark theme' })).getByRole('radio', { name: /Violet/ }));
    expect(update).toHaveBeenLastCalledWith({ ui: { [APP_THEME_DARK_KEY]: 'violet' }, theme: 'dark' });
  });
});
