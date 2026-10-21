// Auto-update in the renderer: the update notice (Restart now / Later, or Download / Later on ad-hoc signed macOS),
// help.checkForUpdates (palette + native menu), the "Automatically check for updates" setting, and the Windows
// overlay title bar's application-menu button. The platform is the real Electron adapter over a fake bridge.
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeUpdate, RELEASES_URL, resetUpdateAnnouncements, useUpdateWiring } from '../../app/updates';
import { CORE_COMMANDS } from '../../commands/core';
import { menuCommandIds, MENUS } from '../../commands/menuModel';
import { setPlatform } from '../../platform';
import type { DbStudioBridge, UpdateStatus } from '../../platform/bridge';
import { createElectronPlatform } from '../../platform/electron';
import { DEFAULT_SETTINGS, useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { updateNotice, useUpdates } from '../../store/updates';
import { Toasts } from '../common/Toasts';
import { SettingsDialog } from './settings/SettingsDialog';
import { useSettingsNav } from './settings/nav';
import { TopBar } from './TopBar';

const status = (s: Partial<UpdateStatus>): UpdateStatus => ({ state: 'idle', mode: 'install', currentVersion: '0.2.0', ...s });

function fakeBridge(over: Partial<DbStudioBridge> = {}) {
  const listeners = new Set<(s: UpdateStatus) => void>();
  const b = {
    platform: 'electron',
    appVersion: '0.2.0',
    getEngineInfo: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1', token: 't' })),
    showSaveDialog: vi.fn(async () => null),
    showOpenDialog: vi.fn(async () => null),
    readTextFile: vi.fn(async () => ''),
    writeTextFile: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
    onMenuCommand: () => () => undefined,
    onEngineRestarted: () => () => undefined,
    loadWorkspace: vi.fn(async () => null),
    saveWorkspace: vi.fn(async () => undefined),
    setTitle: vi.fn(),
    onUpdateStatus: (cb: (s: UpdateStatus) => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    getUpdateStatus: vi.fn(async () => status({})),
    checkForUpdates: vi.fn(async () => status({ state: 'up-to-date' })),
    configureUpdates: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(async () => true),
    setTitleBarTheme: vi.fn(),
    showAppMenu: vi.fn(),
    ...over,
  } satisfies DbStudioBridge;
  const push = (s: UpdateStatus) => act(() => listeners.forEach((l) => l(s)));
  return { b, push };
}

beforeEach(() => {
  resetUpdateAnnouncements();
  useUpdates.setState({ status: null, dismissed: null });
  useUi.setState({ toasts: [] });
  useSettings.setState({ settings: DEFAULT_SETTINGS, loaded: true });
});
afterEach(() => {
  setPlatform(null);
  delete window.dbstudioPlatform;
});

describe('update notice', () => {
  it('Windows / signed macOS: "DbStudio X.Y.Z is ready" — Restart now installs, Later hides it', async () => {
    const { b } = fakeBridge();
    setPlatform(createElectronPlatform(b));
    render(<Toasts />);
    expect(screen.queryByRole('group', { name: 'Update' })).toBeNull();
    act(() => useUpdates.getState().setStatus(status({ state: 'ready', version: '0.3.0', releaseUrl: `${RELEASES_URL}/tag/v0.3.0` })));
    expect(screen.getByRole('group', { name: 'Update' })).toHaveTextContent('DbStudio 0.3.0 is ready');
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await act(async () => undefined);
    expect(b.quitAndInstall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('group', { name: 'Update' })).toBeNull();
    expect(useUpdates.getState().dismissed).toBe('0.3.0');
  });

  it('ad-hoc signed macOS: "is available" — Download opens the release page', async () => {
    const { b } = fakeBridge();
    setPlatform(createElectronPlatform(b));
    render(<Toasts />);
    act(() => useUpdates.getState().setStatus(status({ state: 'available', mode: 'notify', version: '0.3.1', releaseUrl: `${RELEASES_URL}/tag/v0.3.1` })));
    expect(screen.getByRole('group', { name: 'Update' })).toHaveTextContent('DbStudio 0.3.1 is available');
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await act(async () => undefined);
    expect(b.openExternal).toHaveBeenCalledWith(`${RELEASES_URL}/tag/v0.3.1`);
    expect(b.quitAndInstall).not.toHaveBeenCalled();
  });

  it('stays out of the way otherwise', () => {
    for (const s of [
      status({ state: 'checking' }), status({ state: 'up-to-date' }), status({ state: 'downloading', version: '0.3.0', percent: 40 }),
      status({ state: 'error', message: 'offline' }), status({ state: 'disabled', mode: 'disabled' }),
      status({ state: 'available', mode: 'install', version: '0.3.0' }), status({ state: 'ready', version: undefined }),
    ]) expect(updateNotice(s, null), JSON.stringify(s)).toBeNull();
    expect(updateNotice(status({ state: 'ready', version: '0.3.0' }), '0.3.0'), 'dismissed').toBeNull();
    expect(updateNotice(status({ state: 'ready', version: '0.3.1' }), '0.3.0'), 'a newer version shows again').not.toBeNull();
  });

  it('follows the status pushed by the main process', async () => {
    const { b, push } = fakeBridge({ getUpdateStatus: vi.fn(async () => status({ state: 'ready', version: '0.4.0' })) });
    setPlatform(createElectronPlatform(b));
    renderHook(() => useUpdateWiring());
    render(<Toasts />);
    await act(async () => undefined);
    expect(screen.getByRole('group', { name: 'Update' })).toHaveTextContent('DbStudio 0.4.0 is ready');
    push(status({ state: 'ready', version: '0.4.1' }));
    expect(screen.getByRole('group', { name: 'Update' })).toHaveTextContent('DbStudio 0.4.1 is ready');
  });
});

describe('help.checkForUpdates', () => {
  const command = () => CORE_COMMANDS.find((c) => c.id === 'help.checkForUpdates')!;

  it('is a palette command in the macOS app menu and the Windows Help menu', () => {
    expect(command().title).toBe('Check for Updates…');
    expect(command().palette).not.toBe(false);
    const app = MENUS.find((m) => m.id === 'app')!;
    const help = MENUS.find((m) => m.id === 'help')!;
    expect(app.items.some((it) => 'command' in it && it.command === 'help.checkForUpdates')).toBe(true);
    expect(help.items.some((it) => 'command' in it && it.command === 'help.checkForUpdates' && it.platform === 'win32')).toBe(true);
    expect(menuCommandIds('darwin').filter((m) => m.command === 'help.checkForUpdates')).toHaveLength(1);
    expect(menuCommandIds('win32').filter((m) => m.command === 'help.checkForUpdates')).toHaveLength(1);
  });

  it('manual check: "You\'re up to date"', async () => {
    const { b } = fakeBridge();
    setPlatform(createElectronPlatform(b));
    await command().run(undefined as never);
    expect(b.checkForUpdates).toHaveBeenCalledWith({ manual: true });
    expect(useUi.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['success', "You're up to date"]]);
  });

  it('manual check finding a downloaded update shows the notice again after "Later"; errors are a gentle toast', async () => {
    const { b } = fakeBridge({ checkForUpdates: vi.fn(async () => status({ state: 'ready', version: '0.3.0' })) });
    setPlatform(createElectronPlatform(b));
    useUpdates.setState({ dismissed: '0.3.0' });
    await command().run(undefined as never);
    expect(updateNotice(useUpdates.getState().status, useUpdates.getState().dismissed)).toEqual({ kind: 'ready', version: '0.3.0', releaseUrl: undefined });
    expect(useUi.getState().toasts).toEqual([]);

    setPlatform(createElectronPlatform(fakeBridge({ checkForUpdates: vi.fn(async () => status({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' })) }).b));
    await command().run(undefined as never);
    expect(useUi.getState().toasts.map((t) => [t.kind, t.text, t.detail])).toEqual([['warning', "Couldn't check for updates", 'net::ERR_INTERNET_DISCONNECTED']]);
  });

  it('browser build (no updater): opens the releases page', async () => {
    const openExternal = vi.fn(async () => undefined);
    const { b } = fakeBridge({ openExternal });
    const p = createElectronPlatform(b);
    delete (p as { checkForUpdates?: unknown }).checkForUpdates;
    setPlatform(p);
    await command().run(undefined as never);
    expect(openExternal).toHaveBeenCalledWith(RELEASES_URL);
  });
});

describe('"Automatically check for updates" setting', () => {
  it('is reported to the main process once settings are loaded, and on every change', async () => {
    const { b } = fakeBridge();
    setPlatform(createElectronPlatform(b));
    useSettings.setState({ loaded: false });
    renderHook(() => useUpdateWiring());
    expect(b.configureUpdates).not.toHaveBeenCalled();
    act(() => useSettings.setState({ loaded: true }));
    expect(b.configureUpdates).toHaveBeenLastCalledWith({ autoCheck: true });
    act(() => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ui: { autoCheckUpdates: false } } }));
    expect(b.configureUpdates).toHaveBeenLastCalledWith({ autoCheck: false });
  });

  it('is a switch in Settings › Updates (desktop only), on by default', () => {
    const { b } = fakeBridge();
    setPlatform(createElectronPlatform(b));
    const update = vi.spyOn(useSettings.getState(), 'update').mockImplementation(() => undefined);
    useUi.setState({ settingsOpen: true });
    useSettingsNav.setState({ section: 'updates' });
    const { unmount } = render(<SettingsDialog />);
    const box = screen.getByRole('checkbox', { name: 'Automatically check for updates' });
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(update).toHaveBeenCalledWith({ ui: { autoCheckUpdates: false } });
    unmount();
    update.mockRestore();

    setPlatform(null); // browser: no updater, no checkbox
    render(<SettingsDialog />);
    expect(screen.queryByRole('checkbox', { name: 'Automatically check for updates' })).toBeNull();
    useUi.setState({ settingsOpen: false });
  });
});

describe('Windows overlay title bar', () => {
  it('the top bar offers the native application menu (the overlay hides the menu bar)', () => {
    const { b } = fakeBridge();
    setPlatform(createElectronPlatform(b));
    window.dbstudioPlatform = { platform: 'win32', arch: 'x64', titleBar: 'overlay', nativeMaterial: true };
    render(<TopBar theme="light" />);
    fireEvent.click(screen.getByRole('button', { name: 'Application menu' }));
    expect(b.showAppMenu).toHaveBeenCalledTimes(1);
    const pos = (b.showAppMenu as ReturnType<typeof vi.fn>).mock.calls[0][0] as { x: number; y: number };
    expect(Number.isFinite(pos.x) && Number.isFinite(pos.y)).toBe(true);
  });

  it('macOS (traffic lights, native menu bar) has no menu button', () => {
    setPlatform(createElectronPlatform(fakeBridge().b));
    window.dbstudioPlatform = { platform: 'darwin', arch: 'arm64', titleBar: 'inset', nativeMaterial: true };
    render(<TopBar theme="dark" />);
    expect(screen.queryByRole('button', { name: 'Application menu' })).toBeNull();
  });
});

describe('new version announcements', () => {
  it('install mode: one transient toast when the download starts, one OS notification when it is ready', async () => {
    const showNotification = vi.fn();
    const { b, push } = fakeBridge({ showNotification });
    setPlatform(createElectronPlatform(b));
    renderHook(() => useUpdateWiring());
    await act(async () => undefined);
    push(status({ state: 'checking' }));
    push(status({ state: 'available', version: '1.1.0' }));
    push(status({ state: 'downloading', version: '1.1.0', percent: 10 }));
    push(status({ state: 'downloading', version: '1.1.0', percent: 60 }));
    expect(useUi.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['info', 'DbStudio 1.1.0 is available']]);
    expect(showNotification).not.toHaveBeenCalled();
    push(status({ state: 'ready', version: '1.1.0' }));
    push(status({ state: 'ready', version: '1.1.0' }));
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith({ title: 'DbStudio 1.1.0 is ready', body: expect.stringMatching(/Restart/) });
    // the ready card in the toast stack is the in-app notice: no second transient toast
    expect(useUi.getState().toasts).toHaveLength(1);
    // a newer version is announced again
    push(status({ state: 'available', version: '1.2.0' }));
    expect(useUi.getState().toasts.map((t) => t.text)).toEqual(['DbStudio 1.1.0 is available', 'DbStudio 1.2.0 is available']);
  });

  it('notify mode (ad-hoc signed macOS): an OS notification for the available version; no duplicate toast', async () => {
    const showNotification = vi.fn();
    const { b, push } = fakeBridge({ showNotification });
    setPlatform(createElectronPlatform(b));
    renderHook(() => useUpdateWiring());
    await act(async () => undefined);
    push(status({ state: 'available', mode: 'notify', version: '1.1.0' }));
    push(status({ state: 'available', mode: 'notify', version: '1.1.0' }));
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0][0].title).toBe('DbStudio 1.1.0 is available');
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('does not announce what was already pending when the window (re)loads', async () => {
    const showNotification = vi.fn();
    const { b, push } = fakeBridge({ showNotification, getUpdateStatus: vi.fn(async () => status({ state: 'ready', version: '1.1.0' })) });
    setPlatform(createElectronPlatform(b));
    renderHook(() => useUpdateWiring());
    await act(async () => undefined);
    push(status({ state: 'ready', version: '1.1.0' }));
    expect(showNotification).not.toHaveBeenCalled();
    expect(useUi.getState().toasts).toEqual([]);
  });

  it('a manual check that starts the download says so once', async () => {
    const { b, push } = fakeBridge({ checkForUpdates: vi.fn(async () => status({ state: 'downloading', version: '1.1.0', percent: 0 })) });
    setPlatform(createElectronPlatform(b));
    renderHook(() => useUpdateWiring());
    await act(async () => undefined);
    push(status({ state: 'available', version: '1.1.0' }));
    await CORE_COMMANDS.find((c) => c.id === 'help.checkForUpdates')!.run(undefined as never);
    expect(useUi.getState().toasts.map((t) => t.text)).toEqual(['DbStudio 1.1.0 is available']);
  });
});

describe('Settings › Updates', () => {
  it('shows the version and the state machine, checks on demand and offers Restart now when ready', async () => {
    let resolve: (s: UpdateStatus) => void = () => undefined;
    const { b } = fakeBridge({ checkForUpdates: vi.fn(() => new Promise<UpdateStatus>((r) => { resolve = r; })) });
    setPlatform(createElectronPlatform(b));
    useUi.setState({ settingsOpen: true });
    useSettingsNav.setState({ section: 'updates' });
    render(<SettingsDialog />);
    expect(screen.getByText('0.2.0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(b.checkForUpdates).toHaveBeenCalledWith({ manual: true });
    expect(screen.getByRole('status')).toHaveTextContent('Checking for updates…');
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
    await act(async () => resolve(status({ state: 'up-to-date' })));
    expect(screen.getByRole('status')).toHaveTextContent("You're up to date");
    act(() => useUpdates.getState().setStatus(status({ state: 'downloading', version: '0.3.0', percent: 30 })));
    expect(screen.getByRole('status')).toHaveTextContent('Downloading DbStudio 0.3.0… 30%');
    expect(screen.getByRole('progressbar', { name: 'Download progress' })).toHaveAttribute('aria-valuenow', '30');
    act(() => useUpdates.getState().setStatus(status({ state: 'ready', version: '0.3.0' })));
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await act(async () => undefined);
    expect(b.quitAndInstall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /What's new in 0.3.0/ }));
    await act(async () => undefined);
    expect(b.openExternal).toHaveBeenCalledWith(RELEASES_URL);
    useUi.setState({ settingsOpen: false });
  });

  it('describes every state in one line', () => {
    expect(describeUpdate(null).chip).toBeNull();
    expect(describeUpdate(status({ state: 'available', mode: 'notify', version: '2.0.0' })).text).toMatch(/available to download/);
    expect(describeUpdate(status({ state: 'downloading', version: '2.0.0', percent: 140 })).percent).toBe(100);
    expect(describeUpdate(status({ state: 'error', message: 'offline' })).text).toMatch(/offline/);
  });
});
