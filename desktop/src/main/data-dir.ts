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
//   - the Rowlit folder holds the migration marker      -> the move already happened: use it, never look back
//   - the Rowlit folder holds real data of its own      -> use it; a DbStudio folder with data is reported in the log
//     (connections other than the sample, or secrets.dat) but never merged: two real datasets are not mixed blindly
//   - no Rowlit data and a DbStudio folder exists       -> rename DbStudio -> Rowlit (one atomic rename on the same
//     volume; an empty or Chromium-only Rowlit folder is set aside first and removed afterwards), then point saved
//     connections whose file lives inside the old folder (the sample database) at the new folder
//   - a "young" Rowlit folder (no marker, no secrets.dat, no saved connection but the auto-created "Sample: Shop")
//     and a DbStudio folder with real data -> late migration: the young folder is set aside, DbStudio is renamed to
//     Rowlit as above, then the sample connection, its sample/ folder, its diagrams and the old logs are carried over
//     from the set-aside folder, which is removed (or kept when anything could not be carried over). This recovers a
//     first start that did not see the DbStudio folder (see "Virtualised AppData" below).
//   - the rename fails (e.g. a file is still open by an old DbStudio process) -> keep using the DbStudio folder for
//     this run; the move is retried on the next start. Nothing is ever copied half-way or deleted.
//
// Virtualised AppData (Windows): a DbStudio started from inside an MSIX-packaged app (for example from the terminal of
// a packaged desktop app) runs in that app's container, and the files it creates under %APPDATA% really live in
// %LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming. Only processes inside that container see them at
// %APPDATA%\DbStudio. The NSIS update installer starts the new version through Explorer (StdUtils.ExecShellAsUser),
// i.e. outside the container, so Rowlit's first start saw no DbStudio folder and started "fresh". When there is no
// %APPDATA%\DbStudio, the one DbStudio folder found in such package storage (with real data) is used instead.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DATA_FOLDER = 'Rowlit';
export const LEGACY_DATA_FOLDER = 'DbStudio';
export const DATA_DIR_ENV = 'DBSTUDIO_DATA_DIR';
/** Left in the data folder after a successful move (diagnostics, and it stops any later migration attempt). */
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
  /** Human-readable notes for the log (what was found, moved, or why nothing was). Never holds secrets. */
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
  /** Environment: DBSTUDIO_DATA_DIR, and LOCALAPPDATA on Windows (package storage of virtualised AppData). */
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

interface Connection { id?: unknown; name?: unknown; providerId?: unknown; props?: Record<string, unknown> }

/** What a data folder holds, as far as the migration decision goes. File names and counts only (log-safe). */
interface FolderInfo {
  dir: string;
  exists: boolean;
  entries: string[];
  userEntries: string[];
  secrets: boolean;
  /** Saved connections; null when there is no connections.json. */
  connections: number | null;
  /** Ids of the auto-created sample connections (sqlite on <data>/sample/shop.sqlite). */
  sampleIds: string[];
  /** connections.json exists but cannot be read or parsed. */
  unreadable?: string;
  marker: boolean;
}

/** absent / empty (no user data) / young (only the sample connection, no secrets) / real. */
type TargetKind = 'absent' | 'empty' | 'young' | 'real';

/** Resolves (and when allowed, migrates) the data directory. Never throws for migration problems. */
export function resolveDataDir(o: ResolveOptions): DataDirResult {
  const f = o.fs ?? realFs;
  const override = o.env[DATA_DIR_ENV];
  if (override) return { dir: path.resolve(override), source: 'override', notes: [] };

  const platform = o.platform ?? process.platform;
  const target = path.join(o.appData, DATA_FOLDER);
  const legacy = path.join(o.appData, LEGACY_DATA_FOLDER);
  const notes: string[] = [];
  const t = inspect(target, f, platform, [target]);
  const tKind = targetKind(t);
  const current = (): DataDirResult => ({ dir: target, source: t.userEntries.length > 0 ? 'current' : 'fresh', notes });

  if (t.marker) {
    // Settled: never look at the DbStudio folder again (it may be a reinstalled DbStudio's new data).
    notes.push(`${target}: migration marker present`);
    return { dir: target, source: 'current', notes };
  }

  // Where the DbStudio data is, if anywhere.
  let source: string | null = null;
  let virtualised = false;
  if (!samePath(legacy, target, platform) && f.existsSync(legacy)) {
    source = legacy;
  } else if (tKind !== 'real') {
    const found = virtualisedLegacyFolders(o.env, f, platform);
    const withData = found.filter((d) => legacyWorthMoving(inspect(d, f, platform, [d, legacy])));
    if (withData.length === 1) {
      source = withData[0];
      virtualised = true;
      notes.push(`no ${legacy}, but DbStudio data in the virtualised AppData of a packaged app: ${source} (DbStudio was started from inside that app; Rowlit cannot see it at ${legacy})`);
    } else if (withData.length > 1) {
      notes.push(`DbStudio data found in several packaged apps' virtualised AppData (${withData.join(', ')}); none is moved automatically`);
    } else if (found.length > 0) {
      notes.push(`DbStudio folder(s) without user data in packaged apps' virtualised AppData: ${found.join(', ')}`);
    }
  }

  if (!source) {
    notes.push(`no DbStudio folder at ${legacy}`);
    notes.push(describe(t));
    return current();
  }

  const l = inspect(source, f, platform, [source, legacy]);
  notes.push(describe(t));
  notes.push(describe(l));
  if (tKind === 'real') {
    if (legacyWorthMoving(l)) {
      notes.push(`not merged: both ${target} and ${source} hold saved connections or secrets; the DbStudio data stays where it is (merge by hand if it is needed)`);
    }
    return current();
  }
  if (tKind === 'young' && !legacyWorthMoving(l)) {
    notes.push(`nothing to bring over from ${source} (no saved connections other than the sample, no secrets)`);
    return current();
  }
  if (!o.migrate) {
    if (virtualised) {
      notes.push(`unpackaged run: ${source} is not used or moved`);
      return current();
    }
    if (tKind === 'young') {
      notes.push(`unpackaged run: ${legacy} is not moved over the young ${target}`);
      return current();
    }
    notes.push(`using ${legacy} (unpackaged run: the DbStudio folder is not moved)`);
    return { dir: legacy, source: 'legacy', notes };
  }

  // A running DbStudio keeps writing to its folder: moving it under its feet (possible on macOS/Linux) would split the
  // data between two folders. Wait until it has quit.
  if ((o.profileInUse ?? profileInUse)(path.join(source, 'electron'))) {
    notes.push(`${source} is in use by a running app; not moved this time`);
    return { dir: source, source: 'legacy', notes, inUse: true };
  }
  return move(o, f, platform, source, legacy, target, tKind, virtualised, notes);
}

/**
 * Renames `source` to `target`. A Rowlit folder in the way (no user data, or only the sample) is set aside first and
 * removed after the move; from a young one, what the DbStudio data lacks is carried over (carryOver).
 */
function move(o: ResolveOptions, f: FsOps, platform: NodeJS.Platform, source: string, legacy: string, target: string,
  tKind: TargetKind, virtualised: boolean, notes: string[]): DataDirResult {
  const stamp = (o.now?.() ?? new Date()).getTime();
  let aside: string | null = null;
  if (f.existsSync(target)) {
    aside = `${target}.pre-migration-${stamp}`;
    try {
      f.renameSync(target, aside);
    } catch (e) {
      notes.push(`could not set aside ${target}: ${errText(e)}; using ${source}`);
      return { dir: source, source: 'legacy', notes };
    }
  }
  try {
    f.renameSync(source, target);
  } catch (e) {
    if (aside) {
      try { f.renameSync(aside, target); } catch (e2) { notes.push(`could not put ${aside} back: ${errText(e2)}`); }
    }
    // Another instance may have moved it a moment ago.
    if (!f.existsSync(source) && f.existsSync(target) && hasUserData(target, f)) return { dir: target, source: 'current', notes };
    notes.push(`could not move ${source} to ${target}: ${errText(e)}; using ${source} for now (retried on the next start)`);
    const code = (e as NodeJS.ErrnoException)?.code;
    return { dir: source, source: 'legacy', notes, inUse: code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' };
  }
  notes.push(`moved ${source} to ${target}${tKind === 'young' ? ` (late migration: the young Rowlit folder was set aside as ${aside})` : ''}`);
  notes.push(...rewriteConnectionPaths(target, source, target, f, platform));
  if (virtualised) notes.push(...rewriteConnectionPaths(target, legacy, target, f, platform));
  let keptAside = false;
  if (aside) {
    const failures = carryOver(aside, target, stamp, tKind === 'young', f, platform, notes);
    if (failures === 0) {
      try { f.rmSync(aside, { recursive: true, force: true }); } catch (e) { keptAside = true; notes.push(`could not remove ${aside}: ${errText(e)}`); }
    } else {
      keptAside = true;
      notes.push(`kept ${aside}: ${failures} item(s) could not be carried over`);
    }
  }
  try {
    f.writeFileSync(path.join(target, MIGRATION_MARKER), JSON.stringify({
      from: source, to: target, at: (o.now?.() ?? new Date()).toISOString(), version: o.appVersion ?? null,
      late: tKind === 'young', virtualised, previousRowlitFolder: keptAside ? aside : null,
    }, null, 2) + '\n');
  } catch { /* diagnostics only */ }
  return { dir: target, source: 'migrated', notes };
}

/**
 * Carries over from the set-aside Rowlit folder what the moved DbStudio data lacks: its logs (always) and, for a young
 * folder, the sample connection (unless DbStudio has its own), its sample/ folder and the diagrams drawn on it.
 * Returns the number of failures (the set-aside folder is then kept).
 */
function carryOver(aside: string, target: string, stamp: number, young: boolean, f: FsOps, platform: NodeJS.Platform, notes: string[]): number {
  let failures = 0;
  const fail = (what: string, e: unknown) => { failures++; notes.push(`could not carry over ${what}: ${errText(e)}`); };

  const asideLogs = path.join(aside, 'logs');
  if (f.existsSync(asideLogs)) {
    const logs = path.join(target, 'logs');
    const dest = f.existsSync(logs) ? path.join(logs, `before-migration-${stamp}`) : logs;
    try { f.renameSync(asideLogs, dest); } catch (e) { fail('the logs', e); }
  }
  if (!young) return failures;

  // The young sample connection(s), recognised by their file (<data>/sample/shop.sqlite) like the engine does.
  let youngDoc: { connections?: Connection[] };
  try {
    youngDoc = readJson(path.join(aside, 'connections.json'), f) ?? { connections: [] };
  } catch (e) { fail('connections.json', e); return failures; }
  const youngSamples = (Array.isArray(youngDoc.connections) ? youngDoc.connections : []).filter((c) => isSample(c, [target], platform));

  const sampleDir = path.join(target, 'sample');
  const asideSample = path.join(aside, 'sample');
  if (f.existsSync(asideSample) && !f.existsSync(sampleDir)) {
    try { f.renameSync(asideSample, sampleDir); notes.push('carried over the sample database folder'); } catch (e) { fail('the sample folder', e); }
  }
  if (youngSamples.length === 0) return failures;

  // Young sample id -> the id it has from now on (DbStudio's own sample connection when it has one).
  const idMap = new Map<string, string>();
  const connFile = path.join(target, 'connections.json');
  try {
    const doc = readJson<{ version?: unknown; connections?: Connection[] }>(connFile, f) ?? { version: 1, connections: [] };
    const list = Array.isArray(doc.connections) ? doc.connections : (doc.connections = []);
    const own = list.find((c) => isSample(c, [target], platform));
    let added = 0;
    for (const s of youngSamples) {
      if (typeof s.id !== 'string') continue;
      if (own && typeof own.id === 'string') { idMap.set(s.id, own.id); continue; }
      if (list.some((c) => c.id === s.id)) { idMap.set(s.id, s.id); continue; }
      list.push(s);
      idMap.set(s.id, s.id);
      added++;
    }
    if (added > 0) {
      writeJson(connFile, doc, f);
      notes.push('carried over the sample connection');
    }
  } catch (e) { fail('the sample connection', e); return failures; }

  // Diagrams drawn on the young sample (one layout per connection and scope, like DiagramStore).
  const youngDiagrams = path.join(aside, 'diagrams.json');
  if (idMap.size > 0 && f.existsSync(youngDiagrams)) {
    try {
      const youngList = readJson<unknown>(youngDiagrams, f);
      const items = (Array.isArray(youngList) ? youngList : []) as { connectionId?: unknown; scopeKey?: unknown; layout?: { id?: unknown } }[];
      const file = path.join(target, 'diagrams.json');
      const existing = readJson<unknown>(file, f);
      const list = (Array.isArray(existing) ? existing : []) as typeof items;
      let added = 0;
      for (const d of items) {
        const to = typeof d?.connectionId === 'string' ? idMap.get(d.connectionId) : undefined;
        if (!to) continue;
        const clash = list.some((x) => x?.connectionId === to && (x.scopeKey === d.scopeKey || x.layout?.id === d.layout?.id));
        if (clash) continue;
        list.push({ ...d, connectionId: to });
        added++;
      }
      if (added > 0) {
        writeJson(file, list, f);
        notes.push(`carried over ${added} diagram(s) of the sample connection`);
      }
    } catch (e) { fail('the sample diagrams', e); }
  }
  return failures;
}

/** The DbStudio folders inside MSIX package storage: %LOCALAPPDATA%\Packages\<package>\LocalCache\Roaming\DbStudio. */
function virtualisedLegacyFolders(env: NodeJS.ProcessEnv, f: FsOps, platform: NodeJS.Platform): string[] {
  const local = env.LOCALAPPDATA;
  if (platform !== 'win32' || !local) return [];
  const packages = path.join(local, 'Packages');
  let names: string[];
  try {
    names = f.readdirSync(packages);
  } catch {
    return [];
  }
  return names.map((n) => path.join(packages, n, 'LocalCache', 'Roaming', LEGACY_DATA_FOLDER)).filter((d) => f.existsSync(d));
}

function inspect(dir: string, f: FsOps, platform: NodeJS.Platform, sampleRoots: string[]): FolderInfo {
  const info: FolderInfo = { dir, exists: f.existsSync(dir), entries: [], userEntries: [], secrets: false, connections: null, sampleIds: [], marker: false };
  if (!info.exists) return info;
  try {
    info.entries = f.readdirSync(dir);
  } catch (e) {
    info.unreadable = `folder unreadable: ${errText(e)}`;
    return info;
  }
  const lower = new Set(info.entries.map((e) => e.toLowerCase()));
  info.userEntries = info.entries.filter((e) => !NOT_USER_DATA.has(e.toLowerCase()));
  info.secrets = lower.has('secrets.dat');
  info.marker = lower.has(MIGRATION_MARKER);
  if (lower.has('connections.json')) {
    try {
      const doc = readJson<{ connections?: Connection[] }>(path.join(dir, 'connections.json'), f);
      const list = Array.isArray(doc?.connections) ? doc.connections : [];
      info.connections = list.length;
      info.sampleIds = list.filter((c) => isSample(c, sampleRoots, platform)).map((c) => String(c.id));
    } catch (e) {
      info.unreadable = `connections.json unreadable: ${errText(e)}`;
    }
  }
  return info;
}

function targetKind(t: FolderInfo): TargetKind {
  if (!t.exists) return 'absent';
  if (t.unreadable) return 'real'; // cannot tell: treat as real, never move anything over it
  if (t.userEntries.length === 0) return 'empty';
  if (t.secrets || (t.connections ?? 0) > t.sampleIds.length) return 'real';
  return 'young';
}

/** The DbStudio folder holds something the user would miss: saved connections other than the sample, or secrets. */
function legacyWorthMoving(l: FolderInfo): boolean {
  return l.secrets || (l.connections ?? 0) > l.sampleIds.length;
}

/** One log line about a data folder: entry names and counts only, never contents. */
function describe(i: FolderInfo): string {
  if (!i.exists) return `${i.dir}: absent`;
  if (i.unreadable && i.entries.length === 0) return `${i.dir}: ${i.unreadable}`;
  const shown = i.entries.length > 20 ? [...i.entries.slice(0, 20), `+${i.entries.length - 20} more`] : i.entries;
  const parts = [`entries [${shown.join(', ')}]`];
  if (i.userEntries.length === 0) parts.push('no user data');
  if (i.connections !== null) parts.push(`${i.connections} saved connection(s), ${i.sampleIds.length} of them the sample`);
  parts.push(i.secrets ? 'secrets.dat present' : 'no secrets.dat');
  if (i.unreadable) parts.push(i.unreadable);
  return `${i.dir}: ${parts.join('; ')}`;
}

/** The auto-created sample connection: sqlite on <root>/sample/shop.sqlite for one of `roots` (SampleDatabase.cs). */
function isSample(c: Connection, roots: string[], platform: NodeJS.Platform): boolean {
  if (!c || typeof c !== 'object' || String(c.providerId).toLowerCase() !== 'sqlite') return false;
  const p = c.props?.path;
  if (typeof p !== 'string') return false;
  const norm = (s: string) => s.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const fold = platform === 'linux' ? (s: string) => s : (s: string) => s.toLowerCase();
  return roots.some((r) => fold(norm(p)) === fold(norm(path.join(r, 'sample', 'shop.sqlite'))));
}

function hasUserData(dir: string, f: FsOps): boolean {
  try {
    return f.readdirSync(dir).some((e) => !NOT_USER_DATA.has(e.toLowerCase()));
  } catch {
    return false;
  }
}

/** Parsed JSON file, or null when it does not exist. Throws when it cannot be read or parsed. */
function readJson<T>(file: string, f: FsOps): T | null {
  if (!f.existsSync(file)) return null;
  return JSON.parse(f.readFileSync(file, 'utf8')) as T;
}

/** Atomic write (temp file + rename), like the engine's AtomicFile. */
function writeJson(file: string, data: unknown, f: FsOps): void {
  const tmp = `${file}.migrating.tmp`;
  try {
    f.writeFileSync(tmp, JSON.stringify(data, null, 2));
    f.renameSync(tmp, file);
  } catch (e) {
    try { f.rmSync(tmp, { recursive: false, force: true }); } catch { /* ignore */ }
    throw e;
  }
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
