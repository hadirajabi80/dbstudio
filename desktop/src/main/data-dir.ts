// Where Rowlit keeps its data, and the one-time move of the DbStudio data folder (the product was called DbStudio up
// to 1.1.0). Electron-free (unit tested in plain Node: test/data-dir.test.mjs).
//
//   Windows %APPDATA%\Rowlit, macOS ~/Library/Application Support/Rowlit, Linux ~/.config/Rowlit
//   (the engine computes the same folder: engine/src/DbStudio.Core/Platform/DataDirectory.cs, and is also told it
//   explicitly through DBSTUDIO_DATA_DIR by main.ts).
//
// Saved connections, encrypted secrets (secrets.dat: DPAPI on Windows, independent of the folder name; the macOS
// Keychain items keep their "DbStudio" service name, see KeychainSecretStore.cs), settings, history, diagrams, the
// workspace and the Chromium profile (electron/) all live in this one folder, so moving the folder moves everything.
//
// Migration (packaged builds only, so a dev run never moves a developer's real data):
//   - the Rowlit folder already holds data            -> use it, never touch the DbStudio folder
//   - no Rowlit data and a DbStudio folder exists     -> rename DbStudio -> Rowlit (one atomic rename on the same
//     volume; an empty or Chromium-only Rowlit folder is set aside first and removed afterwards), then point saved
//     connections whose file lives inside the old folder (the sample database) at the new folder
//   - the rename fails (e.g. a file is still open by an old DbStudio process) -> keep using the DbStudio folder for
//     this run; the move is retried on the next start. Nothing is ever copied half-way or deleted.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DATA_FOLDER = 'Rowlit';
export const LEGACY_DATA_FOLDER = 'DbStudio';
export const DATA_DIR_ENV = 'DBSTUDIO_DATA_DIR';
/** Left in the data folder after a successful move (diagnostics only). */
export const MIGRATION_MARKER = 'migrated-from-dbstudio.json';

/**
 * Entries that do not count as user data when deciding whether a Rowlit folder is "real": the Chromium profile and
 * logs can appear before any user data is written (a first run that crashed, a dev build).
 */
const NOT_USER_DATA = new Set(['electron', 'logs', 'crashpad', '.ds_store', 'desktop.ini', 'thumbs.db']);

export type DataDirSource = 'override' | 'current' | 'fresh' | 'migrated' | 'legacy';

export interface DataDirResult {
  dir: string;
  source: DataDirSource;
  /** Human-readable notes for the log (what was moved or why the legacy folder is still used). */
  notes: string[];
  /** The DbStudio folder could not be moved because DbStudio (or another process) still has it open. */
  inUse?: boolean;
}

export interface FsOps {
  existsSync(p: string): boolean;
  readdirSync(p: string): string[];
  renameSync(from: string, to: string): void;
  rmSync(p: string, o: { recursive: boolean; force: boolean }): void;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string): void;
}

const realFs: FsOps = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (p) => fs.readdirSync(p),
  renameSync: (a, b) => fs.renameSync(a, b),
  rmSync: (p, o) => fs.rmSync(p, o),
  readFileSync: (p, e) => fs.readFileSync(p, e),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
};

export interface ResolveOptions {
  /** app.getPath('appData'). */
  appData: string;
  env: NodeJS.ProcessEnv;
  /** Move the DbStudio folder when needed (packaged builds). Otherwise an existing DbStudio folder is just used. */
  migrate: boolean;
  platform?: NodeJS.Platform;
  fs?: FsOps;
  now?: () => Date;
  appVersion?: string;
  /** Whether a running app holds the Chromium profile in <dir> (default: profileInUse). */
  profileInUse?: (profileDir: string) => boolean;
}

function hasUserData(dir: string, f: FsOps): boolean {
  try {
    return f.readdirSync(dir).some((e) => !NOT_USER_DATA.has(e.toLowerCase()));
  } catch {
    return false;
  }
}

/** Resolves (and when allowed, migrates) the data directory. Never throws for migration problems. */
export function resolveDataDir(o: ResolveOptions): DataDirResult {
  const f = o.fs ?? realFs;
  const override = o.env[DATA_DIR_ENV];
  if (override) return { dir: path.resolve(override), source: 'override', notes: [] };

  const target = path.join(o.appData, DATA_FOLDER);
  const legacy = path.join(o.appData, LEGACY_DATA_FOLDER);
  if (f.existsSync(target) && hasUserData(target, f)) return { dir: target, source: 'current', notes: [] };
  if (!f.existsSync(legacy) || samePath(legacy, target, o.platform)) return { dir: target, source: 'fresh', notes: [] };
  if (!o.migrate) {
    return { dir: legacy, source: 'legacy', notes: [`using ${legacy} (unpackaged run: the DbStudio folder is not moved)`] };
  }

  const notes: string[] = [];
  // A running DbStudio keeps writing to its folder: moving it under its feet (possible on macOS/Linux) would split the
  // data between two folders. Wait until it has quit.
  if ((o.profileInUse ?? profileInUse)(path.join(legacy, 'electron'))) {
    notes.push(`${legacy} is in use by a running app; not moved this time`);
    return { dir: legacy, source: 'legacy', notes, inUse: true };
  }
  // A Rowlit folder without user data (only a Chromium profile or logs) is set aside so the rename can take its name.
  let aside: string | null = null;
  if (f.existsSync(target)) {
    aside = `${target}.pre-migration-${(o.now?.() ?? new Date()).getTime()}`;
    try {
      f.renameSync(target, aside);
    } catch (e) {
      notes.push(`could not set aside ${target}: ${errText(e)}; using ${legacy}`);
      return { dir: legacy, source: 'legacy', notes };
    }
  }
  try {
    f.renameSync(legacy, target);
  } catch (e) {
    if (aside) {
      try { f.renameSync(aside, target); } catch { /* the set-aside copy holds no user data */ }
    }
    // Another instance may have moved it a moment ago.
    if (f.existsSync(target) && hasUserData(target, f)) return { dir: target, source: 'current', notes };
    notes.push(`could not move ${legacy} to ${target}: ${errText(e)}; using ${legacy} for now (retried on the next start)`);
    const code = (e as NodeJS.ErrnoException)?.code;
    return { dir: legacy, source: 'legacy', notes, inUse: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' };
  }
  notes.push(`moved ${legacy} to ${target}`);
  if (aside) {
    try { f.rmSync(aside, { recursive: true, force: true }); } catch (e) { notes.push(`could not remove ${aside}: ${errText(e)}`); }
  }
  notes.push(...rewriteConnectionPaths(target, legacy, target, f, o.platform));
  try {
    f.writeFileSync(path.join(target, MIGRATION_MARKER), JSON.stringify({
      from: legacy, to: target, at: (o.now?.() ?? new Date()).toISOString(), version: o.appVersion ?? null,
    }, null, 2) + '\n');
  } catch { /* diagnostics only */ }
  return { dir: target, source: 'migrated', notes };
}

/**
 * Saved connections may point at files inside the old folder (the sample database lives in <data>/sample/). Rewrites
 * such string props of connections.json to the new folder, atomically (temp file + rename). Best effort: an unreadable
 * file is left as it is.
 */
export function rewriteConnectionPaths(dataDir: string, from: string, to: string, f: FsOps = realFs, platform: NodeJS.Platform = process.platform): string[] {
  const file = path.join(dataDir, 'connections.json');
  if (!f.existsSync(file)) return [];
  let doc: { connections?: { props?: Record<string, unknown> }[] };
  try {
    doc = JSON.parse(f.readFileSync(file, 'utf8')) as typeof doc;
  } catch (e) {
    return [`connections.json not rewritten (unreadable: ${errText(e)})`];
  }
  let changed = 0;
  for (const c of Array.isArray(doc.connections) ? doc.connections : []) {
    const props = c?.props;
    if (!props || typeof props !== 'object') continue;
    for (const [k, v] of Object.entries(props)) {
      if (typeof v !== 'string') continue;
      const moved = movePath(v, from, to, platform);
      if (moved !== null) { props[k] = moved; changed++; }
    }
  }
  if (changed === 0) return [];
  const tmp = `${file}.migrating.tmp`;
  try {
    f.writeFileSync(tmp, JSON.stringify(doc, null, 2));
    f.renameSync(tmp, file);
  } catch (e) {
    try { f.rmSync(tmp, { recursive: false, force: true }); } catch { /* ignore */ }
    return [`connections.json not rewritten: ${errText(e)}`];
  }
  return [`pointed ${changed} saved connection path(s) at ${to}`];
}

/** `p` re-rooted from `from` to `to` when it lies inside `from` (either slash; case-insensitive on Windows/macOS). */
export function movePath(p: string, from: string, to: string, platform: NodeJS.Platform = process.platform): string | null {
  const norm = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const fold = platform === 'linux' ? (s: string) => s : (s: string) => s.toLowerCase();
  const a = norm(p), base = norm(from);
  if (!fold(a).startsWith(fold(base) + '/')) return null;
  return path.join(to, ...a.slice(base.length + 1).split('/'));
}

/**
 * True when a running Electron app holds the Chromium profile in `profileDir`: on Windows Chromium keeps
 * <profile>/lockfile open without sharing; on macOS/Linux <profile>/SingletonLock is a symlink to "<host>-<pid>".
 */
export function profileInUse(profileDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const lock = path.join(profileDir, 'lockfile');
    if (!fs.existsSync(lock)) return false;
    try {
      fs.closeSync(fs.openSync(lock, 'r+'));
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
    }
  }
  let target: string;
  try {
    target = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return false;
  }
  const pid = Number(/-(\d+)$/.exec(target)?.[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  return err?.code ? `${err.code} ${err.message}` : String(err?.message ?? e);
}
