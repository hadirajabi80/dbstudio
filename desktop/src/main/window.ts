// Main window: hardened webPreferences, CSP, navigation lock, window-state persistence, and a
// background colour that matches the OS theme so there is no white flash before the UI paints.
import { BrowserWindow, nativeTheme, screen, session, shell, type Rectangle } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { APP_VERSION_ARG } from '../shared/channels';
import { buildCsp } from './csp';
import { atomicWriteFile } from './fs-utils';
import { iconPath, windowStateFile } from './paths';
import { desktopOs, windowChrome } from './platform';
import { UI_URL } from './protocol';

interface WindowState { x?: number; y?: number; width: number; height: number; maximized: boolean }

const DEFAULT_STATE: WindowState = { width: 1400, height: 900, maximized: false };
export const DARK_BG = '#1e1e1e';
export const LIGHT_BG = '#ffffff';

function loadState(): WindowState {
  try {
    const s = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8')) as Partial<WindowState>;
    const width = Number(s.width), height = Number(s.height);
    if (!(width >= 400 && height >= 300)) return DEFAULT_STATE;
    const state: WindowState = { width, height, maximized: s.maximized === true };
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      const bounds: Rectangle = { x: s.x!, y: s.y!, width, height };
      // Only restore the position if the window would still be mostly visible (monitor unplugged, etc.).
      const area = screen.getDisplayMatching(bounds).workArea;
      const visibleW = Math.min(bounds.x + width, area.x + area.width) - Math.max(bounds.x, area.x);
      const visibleH = Math.min(bounds.y + height, area.y + area.height) - Math.max(bounds.y, area.y);
      if (visibleW >= 200 && visibleH >= 100) { state.x = s.x; state.y = s.y; }
    }
    return state;
  } catch {
    return DEFAULT_STATE;
  }
}

function trackState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | undefined;
  const snapshot = (): WindowState => {
    const b = win.getNormalBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
  };
  const save = () => { atomicWriteFile(windowStateFile(), JSON.stringify(snapshot())).catch(() => undefined); };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 500); };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => {
    clearTimeout(timer);
    try {
      fs.mkdirSync(path.dirname(windowStateFile()), { recursive: true });
      fs.writeFileSync(windowStateFile(), JSON.stringify(snapshot()));
    } catch { /* best effort */ }
  });
}

/** Origins the renderer may live on: dbstudio://app, plus the Vite dev server when DBSTUDIO_DEV_URL is set. */
export function allowedOrigins(devUrl?: string): string[] {
  const origins = ['dbstudio://app'];
  if (devUrl) origins.push(new URL(devUrl).origin);
  return origins;
}

/** WHATWG URL in Node reports origin "null" for custom schemes, so build it from protocol + host. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.host ? `${u.protocol}//${u.host}` : null;
  } catch {
    return null;
  }
}

export function isAllowedUrl(url: string, devUrl?: string): boolean {
  const origin = originOf(url);
  return origin !== null && allowedOrigins(devUrl).includes(origin);
}

/** CSP for responses that go through the network stack (the Vite dev server); dbstudio:// sets it itself. */
export function installCsp(devUrl?: string): void {
  const csp = buildCsp(devUrl);
  const devOrigin = devUrl ? new URL(devUrl).origin : null;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const origin = originOf(details.url);
    const isDoc = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    if (isDoc && (origin === 'dbstudio://app' || (devOrigin && origin === devOrigin))) {
      const headers = { ...details.responseHeaders };
      for (const k of Object.keys(headers)) if (k.toLowerCase() === 'content-security-policy') delete headers[k];
      headers['Content-Security-Policy'] = [csp];
      callback({ responseHeaders: headers });
      return;
    }
    callback({});
  });

  // Nothing in the app needs camera, geolocation, notifications... Clipboard writes are allowed (copy rows).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'clipboard-sanitized-write' && isAllowedUrl(wc.getURL(), devUrl));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    permission === 'clipboard-sanitized-write' && allowedOrigins(devUrl).includes(requestingOrigin),
  );
}

export interface CreateWindowOptions {
  preloadPath: string;
  appVersion: string;
  devUrl?: string;
  /** false keeps the window hidden (smoke test). */
  show?: boolean;
}

export function createMainWindow(o: CreateWindowOptions): BrowserWindow {
  const state = loadState();
  const icon = iconPath();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'DbStudio',
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
    icon: fs.existsSync(icon) ? icon : undefined,
    autoHideMenuBar: false,
    // macOS: hidden inset title bar, traffic lights inside the renderer's top bar. Windows/Linux: native frame.
    ...windowChrome(desktopOs()),
    webPreferences: {
      preload: o.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      additionalArguments: [`${APP_VERSION_ARG}${o.appVersion}`],
    },
  });
  if (state.maximized) win.maximize();
  trackState(win);

  if (o.show !== false) win.once('ready-to-show', () => win.show());
  // Keep the native background in sync with OS theme changes (visible during reloads).
  const onTheme = () => { if (!win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG); };
  nativeTheme.on('updated', onTheme);
  win.on('closed', () => nativeTheme.removeListener('updated', onTheme));

  // Navigation lock: the renderer can only ever show our UI. Links open in the default browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url, o.devUrl)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.on('will-redirect', (e, url) => { if (!isAllowedUrl(url, o.devUrl)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isAllowedUrl(url, o.devUrl)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  return win;
}

export function uiEntryUrl(devUrl?: string): string {
  return devUrl ?? UI_URL;
}
