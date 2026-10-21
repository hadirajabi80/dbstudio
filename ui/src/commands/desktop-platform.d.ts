// Exposed by the Electron preload (WP-K, desktop/src/main/platform.ts DesktopPlatformInfo), outside the frozen
// DbStudioBridge contract. Undefined in the browser build.
export {};

declare global {
  interface Window {
    dbstudioPlatform?: {
      platform: 'win32' | 'darwin' | 'linux';
      arch: string;
      /** Who draws the title bar; older preloads leave it out. 'overlay': Windows caption buttons over the top bar. */
      titleBar?: 'native' | 'inset' | 'overlay';
      /** A system material (Mica, vibrancy) shows through the top bar. */
      nativeMaterial?: boolean;
    };
  }
}
