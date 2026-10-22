// Data folder resolution and the one-time DbStudio -> Rowlit move (src/main/data-dir.ts), on real temp folders.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { desktopRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const dd = require(join(desktopRoot, 'out', 'lib', 'data-dir.js'));

const notInUse = () => false;

/** A fresh %APPDATA% stand-in. */
function appData() {
  return fs.mkdtempSync(join(tmpdir(), 'rowlit-appdata-'));
}

/** A DbStudio 1.1.0 data folder as the installed app leaves it. */
function seedLegacy(root) {
  const legacy = join(root, 'DbStudio');
  fs.mkdirSync(join(legacy, 'electron', 'Local Storage'), { recursive: true });
  fs.mkdirSync(join(legacy, 'logs'), { recursive: true });
  fs.mkdirSync(join(legacy, 'sample'), { recursive: true });
  const samplePath = join(legacy, 'sample', 'shop.sqlite');
  fs.writeFileSync(samplePath, 'sqlite');
  fs.writeFileSync(join(legacy, 'connections.json'), JSON.stringify({
    version: 1,
    connections: [
      { id: 'c_sample', name: 'Sample: Shop', providerId: 'sqlite', props: { path: samplePath, readOnly: false, createIfMissing: false } },
      { id: 'c_pg', name: 'Prod', providerId: 'postgresql', props: { host: 'db.example', port: 5432, user: 'app' }, savePassword: true },
      { id: 'c_file', name: 'Elsewhere', providerId: 'sqlite', props: { path: join(root, 'other', 'x.sqlite') } },
    ],
  }, null, 2));
  fs.writeFileSync(join(legacy, 'secrets.dat'), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(join(legacy, 'settings.json'), '{"theme":"dark"}');
  fs.writeFileSync(join(legacy, 'history.db'), 'history');
  fs.writeFileSync(join(legacy, 'workspace.json'), '{"tabs":[]}');
  fs.writeFileSync(join(legacy, 'diagrams.json'), '[]');
  fs.writeFileSync(join(legacy, 'electron', 'Local Storage', '000003.log'), 'ls');
  return { legacy, samplePath };
}

describe('resolveDataDir', () => {
  it('DBSTUDIO_DATA_DIR overrides everything and never migrates', () => {
    const root = appData();
    seedLegacy(root);
    const r = dd.resolveDataDir({ appData: root, env: { DBSTUDIO_DATA_DIR: join(root, 'custom') }, migrate: true, profileInUse: notInUse });
    assert.equal(r.source, 'override');
    assert.equal(r.dir, join(root, 'custom'));
    assert.ok(fs.existsSync(join(root, 'DbStudio', 'connections.json')), 'legacy folder untouched');
  });

  it('fresh install: <appData>/Rowlit, nothing created or moved', () => {
    const root = appData();
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse });
    assert.deepEqual([r.source, r.dir], ['fresh', join(root, 'Rowlit')]);
    assert.deepEqual(fs.readdirSync(root), []);
  });

  it('moves the DbStudio folder to Rowlit with everything in it, and re-points the sample connection', () => {
    const root = appData();
    const { samplePath } = seedLegacy(root);
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse, appVersion: '1.2.0', now: () => new Date('2026-10-22T10:00:00Z') });
    const target = join(root, 'Rowlit');
    assert.equal(r.source, 'migrated');
    assert.equal(r.dir, target);
    assert.equal(fs.existsSync(join(root, 'DbStudio')), false, 'moved, not copied');
    for (const f of ['secrets.dat', 'settings.json', 'history.db', 'workspace.json', 'diagrams.json', join('sample', 'shop.sqlite'), join('electron', 'Local Storage', '000003.log')]) {
      assert.ok(fs.existsSync(join(target, f)), f);
    }
    assert.deepEqual([...fs.readFileSync(join(target, 'secrets.dat'))], [1, 2, 3, 4], 'secrets byte-identical (DPAPI blobs do not depend on the folder)');
    const doc = JSON.parse(fs.readFileSync(join(target, 'connections.json'), 'utf8'));
    const byId = Object.fromEntries(doc.connections.map((c) => [c.id, c]));
    assert.equal(byId.c_sample.props.path, join(target, 'sample', 'shop.sqlite'));
    assert.notEqual(byId.c_sample.props.path, samplePath);
    assert.deepEqual(byId.c_pg.props, { host: 'db.example', port: 5432, user: 'app' });
    assert.equal(byId.c_pg.savePassword, true);
    assert.equal(byId.c_file.props.path, join(root, 'other', 'x.sqlite'), 'paths outside the data folder are kept');
    const marker = JSON.parse(fs.readFileSync(join(target, dd.MIGRATION_MARKER), 'utf8'));
    assert.equal(marker.version, '1.2.0');
    assert.ok(r.notes.some((n) => n.includes('moved')), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => n.includes('1 saved connection')), r.notes.join('\n'));
  });

  it('second start after the move: uses Rowlit and leaves a later DbStudio folder alone', () => {
    const root = appData();
    seedLegacy(root);
    dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse });
    // e.g. DbStudio 1.1.0 reinstalled and started once
    fs.mkdirSync(join(root, 'DbStudio'));
    fs.writeFileSync(join(root, 'DbStudio', 'settings.json'), '{}');
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse });
    assert.deepEqual([r.source, r.dir], ['current', join(root, 'Rowlit')]);
    assert.ok(fs.existsSync(join(root, 'DbStudio', 'settings.json')));
  });

  it('a Rowlit folder holding only a Chromium profile and logs does not block the move', () => {
    const root = appData();
    seedLegacy(root);
    fs.mkdirSync(join(root, 'Rowlit', 'electron'), { recursive: true });
    fs.mkdirSync(join(root, 'Rowlit', 'logs'));
    fs.writeFileSync(join(root, 'Rowlit', 'logs', 'engine-process.log'), 'x');
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse, now: () => new Date(5) });
    assert.equal(r.source, 'migrated');
    assert.ok(fs.existsSync(join(root, 'Rowlit', 'connections.json')));
    assert.equal(fs.existsSync(join(root, 'Rowlit.pre-migration-5')), false, 'the set-aside folder is removed');
    assert.equal(fs.existsSync(join(root, 'DbStudio')), false);
  });

  it('a Rowlit folder with user data wins: the DbStudio folder is never merged or touched', () => {
    const root = appData();
    seedLegacy(root);
    fs.mkdirSync(join(root, 'Rowlit'));
    fs.writeFileSync(join(root, 'Rowlit', 'settings.json'), '{"theme":"light"}');
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse });
    assert.deepEqual([r.source, r.dir], ['current', join(root, 'Rowlit')]);
    assert.ok(fs.existsSync(join(root, 'DbStudio', 'connections.json')));
    assert.equal(fs.readFileSync(join(root, 'Rowlit', 'settings.json'), 'utf8'), '{"theme":"light"}');
  });

  it('unpackaged (dev) runs use an existing DbStudio folder without moving it', () => {
    const root = appData();
    seedLegacy(root);
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: false, profileInUse: notInUse });
    assert.deepEqual([r.source, r.dir], ['legacy', join(root, 'DbStudio')]);
    assert.equal(fs.existsSync(join(root, 'Rowlit')), false);
  });

  it('DbStudio still running: no move (it would split the data), the old folder is used and reported in use', () => {
    const root = appData();
    seedLegacy(root);
    const seen = [];
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: (p) => { seen.push(p); return true; } });
    assert.deepEqual(seen, [join(root, 'DbStudio', 'electron')]);
    assert.deepEqual([r.source, r.dir, r.inUse], ['legacy', join(root, 'DbStudio'), true]);
    assert.ok(fs.existsSync(join(root, 'DbStudio', 'connections.json')));
    assert.equal(fs.existsSync(join(root, 'Rowlit')), false);
  });

  it('a failed rename keeps the old folder in use (nothing half-copied) and restores a set-aside Rowlit folder', () => {
    const root = appData();
    seedLegacy(root);
    fs.mkdirSync(join(root, 'Rowlit', 'electron'), { recursive: true });
    const real = { ...fs, existsSync: fs.existsSync, readdirSync: fs.readdirSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync };
    const ops = {
      ...real,
      renameSync: (a, b) => {
        if (a.endsWith('DbStudio')) { const e = new Error('resource busy'); e.code = 'EBUSY'; throw e; }
        fs.renameSync(a, b);
      },
    };
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, fs: ops, profileInUse: notInUse, now: () => new Date(7) });
    assert.deepEqual([r.source, r.dir, r.inUse], ['legacy', join(root, 'DbStudio'), true]);
    assert.ok(fs.existsSync(join(root, 'Rowlit', 'electron')), 'set-aside folder put back');
    assert.equal(fs.existsSync(join(root, 'Rowlit.pre-migration-7')), false);
    assert.ok(fs.existsSync(join(root, 'DbStudio', 'secrets.dat')));
    // next start, nothing in the way any more: the move happens
    const r2 = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse });
    assert.equal(r2.source, 'migrated');
    assert.ok(fs.existsSync(join(root, 'Rowlit', 'secrets.dat')));
  });

  it('a concurrent start that already moved the folder is picked up', () => {
    const root = appData();
    seedLegacy(root);
    const ops = {
      existsSync: fs.existsSync, readdirSync: fs.readdirSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync,
      renameSync: (a, b) => { fs.renameSync(a, b); const e = new Error('gone'); e.code = 'ENOENT'; throw e; }, // the other instance won
    };
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, fs: ops, profileInUse: notInUse });
    assert.deepEqual([r.source, r.dir], ['current', join(root, 'Rowlit')]);
  });
});

describe('movePath / rewriteConnectionPaths', () => {
  it('re-roots paths inside the old folder only, either slash, case-insensitive on Windows/macOS', () => {
    const from = join('C:', 'Users', 'me', 'AppData', 'Roaming', 'DbStudio');
    const to = join('C:', 'Users', 'me', 'AppData', 'Roaming', 'Rowlit');
    assert.equal(dd.movePath(`${from}/sample/shop.sqlite`, from, to, 'win32'), join(to, 'sample', 'shop.sqlite'));
    assert.equal(dd.movePath(`${from.toUpperCase()}\\sample\\shop.sqlite`, from, to, 'win32'), join(to, 'sample', 'shop.sqlite'));
    assert.equal(dd.movePath(`${from}2/x.sqlite`, from, to, 'win32'), null, 'a sibling with a longer name is not inside');
    assert.equal(dd.movePath('D:/data/x.sqlite', from, to, 'win32'), null);
    assert.equal(dd.movePath('/Users/me/Library/Application Support/dbstudio/a.db', '/Users/me/Library/Application Support/DbStudio', '/R', 'linux'), null, 'case-sensitive on Linux');
  });

  it('leaves an unreadable connections.json alone', () => {
    const dir = appData();
    fs.writeFileSync(join(dir, 'connections.json'), '{not json');
    const notes = dd.rewriteConnectionPaths(dir, join(dir, 'a'), join(dir, 'b'));
    assert.match(notes[0], /not rewritten/);
    assert.equal(fs.readFileSync(join(dir, 'connections.json'), 'utf8'), '{not json');
  });
});

describe('profileInUse', () => {
  it('no profile, or no lock: not in use', () => {
    const dir = appData();
    assert.equal(dd.profileInUse(join(dir, 'missing')), false);
    assert.equal(dd.profileInUse(dir), false);
  });

  it('macOS/Linux: a SingletonLock pointing at a live pid is in use, a stale one is not', { skip: process.platform === 'win32' && 'POSIX symlink lock' }, () => {
    const dir = appData();
    fs.symlinkSync(`host-${process.pid}`, join(dir, 'SingletonLock'));
    assert.equal(dd.profileInUse(dir), true);
    const stale = appData();
    fs.symlinkSync('host-999999', join(stale, 'SingletonLock'));
    assert.equal(dd.profileInUse(stale), false);
  });

  it('Windows: a lockfile held open without sharing is in use, a leftover one is not', { skip: process.platform !== 'win32' && 'Windows lockfile' }, () => {
    const dir = appData();
    fs.writeFileSync(join(dir, 'lockfile'), '');
    assert.equal(dd.profileInUse(dir), false, 'leftover lockfile of an app that has quit');
  });
});
