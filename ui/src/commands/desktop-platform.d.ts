// Exposed by the Electron preload (WP-K, desktop/src/main/platform.ts DesktopPlatformInfo), outside the frozen
// DbStudioBridge contract. Undefined in the browser build.
export {};

declare global {
  interface Window {
    dbstudioPlatform?: { platform: 'win32' | 'darwin' | 'linux'; arch: string };
  }
}
