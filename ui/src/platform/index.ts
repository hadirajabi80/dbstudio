import './bridge';
import { createBrowserPlatform } from './browser';
import { createElectronPlatform } from './electron';
import type { Platform } from './types';

export type { Platform } from './types';
export type { EngineInfo, FileFilter, MenuCommand } from './types';

let current: Platform | null = null;

/** The host adapter: Electron preload bridge when present, browser fallbacks otherwise. */
export function getPlatform(): Platform {
  if (!current) current = typeof window !== 'undefined' && window.dbstudio ? createElectronPlatform(window.dbstudio) : createBrowserPlatform();
  return current;
}

/** Tests can substitute the platform. */
export function setPlatform(p: Platform | null): void {
  current = p;
}
