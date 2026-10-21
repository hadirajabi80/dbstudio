// Argument validation for every IPC call. Electron-free so it can be unit tested in plain Node.
import * as path from 'node:path';
import type { FileFilter } from '../../../ui/src/platform/bridge';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const LIMITS = {
  pathLength: 32_000,
  titleLength: 300,
  urlLength: 4096,
  filters: 32,
  extensionsPerFilter: 32,
  /** Max size of a file read into the editor. */
  readBytes: 64 * 1024 * 1024,
  /** Max length (UTF-16 code units) of text written to a file. */
  writeChars: 256 * 1024 * 1024,
  /** Max serialized size of workspace.json. */
  workspaceChars: 64 * 1024 * 1024,
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function optionalString(v: unknown, name: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ValidationError(`${name} must be a string`);
  if (v.length > max) throw new ValidationError(`${name} is too long`);
  return v;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function validateTitle(v: unknown): string {
  if (typeof v !== 'string') throw new ValidationError('title must be a string');
  return v.replace(CONTROL_CHARS, ' ').slice(0, LIMITS.titleLength);
}

/**
 * A local absolute file path. Rejects device namespaces (\\?\, \\.\), NUL bytes and relative paths.
 * UNC shares (\\server\share\file.sql) are allowed: people do keep scripts on shares.
 */
export function validateFilePath(v: unknown, name = 'path', platform: NodeJS.Platform = process.platform): string {
  if (typeof v !== 'string' || v.length === 0) throw new ValidationError(`${name} must be a non-empty string`);
  if (v.length > LIMITS.pathLength) throw new ValidationError(`${name} is too long`);
  if (v.includes('\0')) throw new ValidationError(`${name} contains a NUL character`);
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32' && /^[\\/][\\/][?.][\\/]/.test(v)) throw new ValidationError(`${name} uses a device namespace`);
  if (!p.isAbsolute(v)) throw new ValidationError(`${name} must be absolute`);
  if (platform === 'win32' && /^[\\/](?![\\/])/.test(v)) throw new ValidationError(`${name} must include a drive letter`);
  return p.normalize(v);
}

/** Text, or bytes for binary files (an .xlsx export arrives as a Uint8Array over IPC). */
export function validateFileContent(v: unknown): string | Uint8Array {
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    if (v.byteLength > LIMITS.writeChars) throw new ValidationError('content is too large');
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (typeof v !== 'string') throw new ValidationError('content must be a string or bytes');
  if (v.length > LIMITS.writeChars) throw new ValidationError('content is too large');
  return v;
}

export function validateFilters(v: unknown): FileFilter[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ValidationError('filters must be an array');
  if (v.length > LIMITS.filters) throw new ValidationError('too many filters');
  return v.map((f, i): FileFilter => {
    if (!isPlainObject(f)) throw new ValidationError(`filters[${i}] must be an object`);
    const name = optionalString(f.name, `filters[${i}].name`, 200) ?? '';
    if (!Array.isArray(f.extensions)) throw new ValidationError(`filters[${i}].extensions must be an array`);
    if (f.extensions.length > LIMITS.extensionsPerFilter) throw new ValidationError(`filters[${i}] has too many extensions`);
    const extensions = f.extensions.map((e: unknown) => {
      if (typeof e !== 'string') throw new ValidationError(`filters[${i}].extensions must be strings`);
      // Accept "sql", ".sql", "*.sql" and "*"; Electron wants bare extensions.
      const bare = e.replace(/^\*?\./, '');
      if (!/^(\*|[A-Za-z0-9_-]{1,32})$/.test(bare)) throw new ValidationError(`invalid extension "${e}"`);
      return bare;
    });
    return { name: name.replace(CONTROL_CHARS, ' '), extensions };
  });
}

export interface SaveDialogArgs { title?: string; defaultPath?: string; filters?: FileFilter[] }
export interface OpenDialogArgs { title?: string; filters?: FileFilter[]; createIfMissing: boolean }

export function validateSaveDialogArgs(v: unknown): SaveDialogArgs {
  const o = v === undefined || v === null ? {} : v;
  if (!isPlainObject(o)) throw new ValidationError('options must be an object');
  const defaultPath = optionalString(o.defaultPath, 'defaultPath', LIMITS.pathLength);
  if (defaultPath !== undefined && defaultPath.includes('\0')) throw new ValidationError('defaultPath contains a NUL character');
  return {
    title: optionalString(o.title, 'title', LIMITS.titleLength)?.replace(CONTROL_CHARS, ' '),
    defaultPath,
    filters: validateFilters(o.filters),
  };
}

export function validateOpenDialogArgs(v: unknown): OpenDialogArgs {
  const o = v === undefined || v === null ? {} : v;
  if (!isPlainObject(o)) throw new ValidationError('options must be an object');
  if (o.createIfMissing !== undefined && typeof o.createIfMissing !== 'boolean') {
    throw new ValidationError('createIfMissing must be a boolean');
  }
  return {
    title: optionalString(o.title, 'title', LIMITS.titleLength)?.replace(CONTROL_CHARS, ' '),
    filters: validateFilters(o.filters),
    createIfMissing: o.createIfMissing === true,
  };
}

/** Only http(s) URLs leave the app; everything else (file:, javascript:, ms-settings:, ...) is refused. */
export function validateExternalUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new ValidationError('url must be a non-empty string');
  if (v.length > LIMITS.urlLength) throw new ValidationError('url is too long');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ValidationError('url is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ValidationError('only http and https URLs can be opened');
  if (u.username || u.password) throw new ValidationError('urls with credentials are not allowed');
  return u.toString();
}

/** updates.check({ manual }) */
export function validateUpdateCheckArgs(v: unknown): { manual: boolean } {
  const o = v === undefined || v === null ? {} : v;
  if (!isPlainObject(o)) throw new ValidationError('options must be an object');
  if (o.manual !== undefined && typeof o.manual !== 'boolean') throw new ValidationError('manual must be a boolean');
  return { manual: o.manual === true };
}

/** updates.configure({ autoCheck }) */
export function validateUpdateConfig(v: unknown): { autoCheck: boolean } {
  if (!isPlainObject(v)) throw new ValidationError('options must be an object');
  if (typeof v.autoCheck !== 'boolean') throw new ValidationError('autoCheck must be a boolean');
  return { autoCheck: v.autoCheck };
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export interface TitleBarThemeArgs { theme: 'system' | 'light' | 'dark'; color: string; symbolColor: string; height?: number }

/**
 * setTitleBarTheme: the theme setting plus the caption-button colours as #rrggbb / #rrggbbaa (nothing else reaches
 * Electron's colour parser) and an optional overlay height, clamped to a sane range.
 */
export function validateTitleBarTheme(v: unknown): TitleBarThemeArgs {
  if (!isPlainObject(v)) throw new ValidationError('title bar theme must be an object');
  if (v.theme !== 'system' && v.theme !== 'light' && v.theme !== 'dark') throw new ValidationError('theme must be system, light or dark');
  if (typeof v.color !== 'string' || !HEX_COLOR.test(v.color)) throw new ValidationError('color must be #rrggbb or #rrggbbaa');
  if (typeof v.symbolColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v.symbolColor)) throw new ValidationError('symbolColor must be #rrggbb');
  let height: number | undefined;
  if (v.height !== undefined) {
    if (typeof v.height !== 'number' || !Number.isFinite(v.height)) throw new ValidationError('height must be a number');
    height = Math.round(Math.max(24, Math.min(96, v.height)));
  }
  return { theme: v.theme, color: v.color, symbolColor: v.symbolColor, ...(height !== undefined ? { height } : {}) };
}

/** showAppMenu({ x, y }): a point in window coordinates (rounded, kept within a generous window size). */
export function validateMenuPosition(v: unknown): { x: number; y: number } {
  if (!isPlainObject(v)) throw new ValidationError('position must be an object');
  const coord = (n: unknown, name: string) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ValidationError(`${name} must be a number`);
    return Math.round(Math.max(0, Math.min(100_000, n)));
  };
  return { x: coord(v.x, 'x'), y: coord(v.y, 'y') };
}

/** Serializes the workspace payload (already structured-cloned by IPC) and enforces a size cap. */
export function serializeWorkspace(v: unknown): string {
  if (v === undefined) throw new ValidationError('workspace data is required');
  let json: string | undefined;
  try {
    json = JSON.stringify(v);
  } catch (e) {
    throw new ValidationError(`workspace data is not JSON-serializable: ${(e as Error).message}`);
  }
  if (json === undefined) throw new ValidationError('workspace data is not JSON-serializable');
  if (json.length > LIMITS.workspaceChars) throw new ValidationError('workspace data is too large');
  return json;
}
