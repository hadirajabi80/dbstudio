// Data folder resolution and the one-time DbStudio -> Rowlit move (src/main/data-dir.ts), on real temp folders.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

  it('a Rowlit folder with real data of its own wins: the DbStudio folder is never merged or touched', () => {
    const root = appData();
    seedLegacy(root);
    fs.mkdirSync(join(root, 'Rowlit'));
    fs.writeFileSync(join(root, 'Rowlit', 'settings.json'), '{"theme":"light"}');
    fs.writeFileSync(join(root, 'Rowlit', 'connections.json'), JSON.stringify({ version: 1, connections: [
      { id: 'c_own', name: 'Mine', providerId: 'postgresql', props: { host: 'h' } },
    ] }));
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse });
    assert.deepEqual([r.source, r.dir], ['current', join(root, 'Rowlit')]);
    assert.ok(fs.existsSync(join(root, 'DbStudio', 'connections.json')));
    assert.equal(fs.readFileSync(join(root, 'Rowlit', 'settings.json'), 'utf8'), '{"theme":"light"}');
    assert.ok(r.notes.some((n) => n.includes('not merged')), r.notes.join('\n'));
  });

  it('late migration on real folders: a young Rowlit folder (only the sample) is replaced by the DbStudio data', () => {
    const root = appData();
    seedLegacy(root);
    const target = join(root, 'Rowlit');
    fs.mkdirSync(join(target, 'sample'), { recursive: true });
    fs.mkdirSync(join(target, 'logs'));
    fs.writeFileSync(join(target, 'logs', 'engine-process.log'), 'young log');
    fs.writeFileSync(join(target, 'sample', 'shop.sqlite'), 'young sqlite');
    fs.writeFileSync(join(target, 'settings.json'), '{}');
    fs.writeFileSync(join(target, 'connections.json'), JSON.stringify({ version: 1, connections: [
      { id: 'c_young', name: 'Sample: Shop', providerId: 'sqlite', props: { path: join(target, 'sample', 'shop.sqlite') } },
    ] }));
    const r = dd.resolveDataDir({ appData: root, env: {}, migrate: true, profileInUse: notInUse, now: () => new Date(9) });
    assert.equal(r.source, 'migrated', r.notes.join('\n'));
    assert.equal(fs.existsSync(join(root, 'DbStudio')), false);
    assert.equal(fs.existsSync(join(root, 'Rowlit.pre-migration-9')), false, 'set-aside folder removed');
    assert.deepEqual([...fs.readFileSync(join(target, 'secrets.dat'))], [1, 2, 3, 4]);
    assert.equal(fs.readFileSync(join(target, 'settings.json'), 'utf8'), '{"theme":"dark"}', 'DbStudio settings win');
    assert.equal(fs.readFileSync(join(target, 'sample', 'shop.sqlite'), 'utf8'), 'sqlite', "DbStudio's own sample kept");
    assert.equal(fs.readFileSync(join(target, 'logs', 'before-migration-9', 'engine-process.log'), 'utf8'), 'young log');
    const ids = JSON.parse(fs.readFileSync(join(target, 'connections.json'), 'utf8')).connections.map((c) => c.id);
    assert.deepEqual(ids, ['c_sample', 'c_pg', 'c_file'], 'DbStudio already has a sample: no second one');
    assert.equal(JSON.parse(fs.readFileSync(join(target, dd.MIGRATION_MARKER), 'utf8')).late, true);
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

// In-memory FsOps: the decision logic (late migration, refusals, diagnostics, virtualised AppData) without disk I/O.
function fakeFs() {
  const nodes = new Map(); // path -> { dir: true } | { data: string }
  const err = (code) => Object.assign(new Error(code), { code });
  const under = (k, p) => k === p || k.startsWith(p.endsWith(sep) ? p : p + sep);
  const x = {
    nodes,
    mkdir(p) {
      for (let q = p; !nodes.has(q); q = dirname(q)) {
        nodes.set(q, { dir: true });
        if (dirname(q) === q) break;
      }
    },
    file(p, data) {
      x.mkdir(dirname(p));
      nodes.set(p, { data: typeof data === 'string' ? data : JSON.stringify(data) });
    },
    json: (p) => JSON.parse(x.readFileSync(p, 'utf8')),
    existsSync: (p) => nodes.has(p),
    readdirSync: (p) => {
      if (!nodes.get(p)?.dir) throw err('ENOENT');
      return [...nodes.keys()].filter((k) => k !== p && dirname(k) === p).map((k) => basename(k));
    },
    renameSync: (a, b) => {
      const n = nodes.get(a);
      if (!n || !nodes.get(dirname(b))?.dir) throw err('ENOENT');
      if (nodes.has(b) && (n.dir || nodes.get(b).dir)) throw err('EPERM');
      const moving = [...nodes.entries()].filter(([k]) => under(k, a));
      for (const [k] of moving) nodes.delete(k);
      for (const [k, v] of moving) nodes.set(b + k.slice(a.length), v);
    },
    rmSync: (p, o) => {
      if (!nodes.has(p)) { if (o.force) return; throw err('ENOENT'); }
      for (const k of [...nodes.keys()]) if (under(k, p)) nodes.delete(k);
    },
    readFileSync: (p) => {
      const n = nodes.get(p);
      if (!n || n.dir) throw err('ENOENT');
      return n.data;
    },
    writeFileSync: (p, d) => {
      if (!nodes.get(dirname(p))?.dir) throw err('ENOENT');
      nodes.set(p, { data: String(d) });
    },
  };
  return x;
}

const ROOT = resolve('/fake-user/AppData/Roaming');
const TARGET = join(ROOT, 'Rowlit');
const LEGACY = join(ROOT, 'DbStudio');

/** DbStudio data with real connections and secrets; `sample` adds its own sample connection. */
function fakeLegacy(x, dir = LEGACY, { sample = false, samplePathRoot = dir } = {}) {
  x.mkdir(join(dir, 'electron'));
  x.file(join(dir, 'logs', 'engine-process.log'), 'old log');
  x.file(join(dir, 'secrets.dat'), 'DPAPI-BLOB');
  x.file(join(dir, 'settings.json'), '{"theme":"dark"}');
  x.file(join(dir, 'history.db'), 'history');
  const connections = [{ id: 'c_pg', name: 'Prod', providerId: 'postgresql', props: { host: 'db.example', user: 'app' }, savePassword: true }];
  if (sample) {
    connections.unshift({ id: 'c_oldsample', name: 'Sample: Shop', providerId: 'sqlite', props: { path: join(samplePathRoot, 'sample', 'shop.sqlite') } });
    x.file(join(dir, 'sample', 'shop.sqlite'), 'old sqlite');
  }
  x.file(join(dir, 'connections.json'), { version: 1, connections });
  x.file(join(dir, 'diagrams.json'), [{ connectionId: 'c_pg', scopeKey: 'app|public', layout: { id: 'd_pg' } }]);
}

/** What a first Rowlit start leaves when it did not see the DbStudio data and the user opened the sample. */
function fakeYoung(x, { diagrams = [{ connectionId: 'c_young', scopeKey: '|main', layout: { id: 'd_young' } }] } = {}) {
  x.mkdir(join(TARGET, 'electron'));
  x.file(join(TARGET, 'logs', 'engine-process.log'), 'young log');
  x.file(join(TARGET, 'settings.json'), '{}');
  x.file(join(TARGET, 'history.db'), 'young history');
  x.file(join(TARGET, 'sample', 'shop.sqlite'), 'young sqlite');
  x.file(join(TARGET, 'connections.json'), { version: 1, connections: [
    { id: 'c_young', name: 'Sample: Shop', providerId: 'sqlite', color: '#16a34a', props: { path: join(TARGET, 'sample', 'shop.sqlite'), readOnly: false, createIfMissing: false } },
  ] });
  if (diagrams) x.file(join(TARGET, 'diagrams.json'), diagrams);
}

const resolveFake = (x, extra = {}) => dd.resolveDataDir({ appData: ROOT, env: {}, migrate: true, fs: x, profileInUse: notInUse, now: () => new Date(42), appVersion: '1.2.2', ...extra });
const aside = `${TARGET}.pre-migration-42`;

describe('resolveDataDir: late migration of a young Rowlit folder (in-memory fs)', () => {
  it('moves the DbStudio data in and carries over the sample connection, its folder, its diagrams and the logs', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x);
    const r = resolveFake(x);
    assert.deepEqual([r.source, r.dir], ['migrated', TARGET], r.notes.join('\n'));
    assert.equal(x.existsSync(LEGACY), false, 'moved, not copied');
    assert.equal(x.existsSync(aside), false, 'set-aside folder removed');
    assert.equal(x.readFileSync(join(TARGET, 'secrets.dat')), 'DPAPI-BLOB');
    assert.equal(x.readFileSync(join(TARGET, 'settings.json')), '{"theme":"dark"}', 'DbStudio data wins');
    assert.equal(x.readFileSync(join(TARGET, 'history.db')), 'history');
    const conns = x.json(join(TARGET, 'connections.json')).connections;
    assert.deepEqual(conns.map((c) => c.id), ['c_pg', 'c_young']);
    assert.equal(conns[1].props.path, join(TARGET, 'sample', 'shop.sqlite'));
    assert.equal(x.readFileSync(join(TARGET, 'sample', 'shop.sqlite')), 'young sqlite', 'sample folder carried over');
    assert.deepEqual(x.json(join(TARGET, 'diagrams.json')).map((d) => [d.connectionId, d.layout.id]), [['c_pg', 'd_pg'], ['c_young', 'd_young']]);
    assert.equal(x.readFileSync(join(TARGET, 'logs', 'engine-process.log')), 'old log');
    assert.equal(x.readFileSync(join(TARGET, 'logs', 'before-migration-42', 'engine-process.log')), 'young log');
    const marker = x.json(join(TARGET, dd.MIGRATION_MARKER));
    assert.deepEqual([marker.from, marker.late, marker.virtualised, marker.previousRowlitFolder, marker.version], [LEGACY, true, false, null, '1.2.2']);
    assert.ok(r.notes.some((n) => n.includes('late migration')), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => n.includes('carried over the sample connection')), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => n.includes('carried over 1 diagram')), r.notes.join('\n'));
    assert.equal([...x.nodes.keys()].some((k) => k.endsWith('.migrating.tmp')), false, 'no temp files left');
  });

  it('DbStudio has its own sample: no second sample connection, the young diagrams move to it', () => {
    const x = fakeFs();
    fakeLegacy(x, LEGACY, { sample: true });
    fakeYoung(x);
    const r = resolveFake(x);
    assert.equal(r.source, 'migrated', r.notes.join('\n'));
    const conns = x.json(join(TARGET, 'connections.json')).connections;
    assert.deepEqual(conns.map((c) => c.id), ['c_oldsample', 'c_pg']);
    assert.equal(conns[0].props.path, join(TARGET, 'sample', 'shop.sqlite'), 're-pointed at the new folder');
    assert.equal(x.readFileSync(join(TARGET, 'sample', 'shop.sqlite')), 'old sqlite');
    assert.deepEqual(x.json(join(TARGET, 'diagrams.json')).map((d) => [d.connectionId, d.layout.id]), [['c_pg', 'd_pg'], ['c_oldsample', 'd_young']]);
    assert.equal(x.existsSync(aside), false);
  });

  it('a carry-over failure keeps the set-aside folder (nothing is lost) and records it in the marker', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x, { diagrams: '{broken' });
    const r = resolveFake(x);
    assert.equal(r.source, 'migrated');
    assert.ok(x.existsSync(join(aside, 'diagrams.json')), 'set-aside folder kept');
    assert.equal(x.json(join(TARGET, dd.MIGRATION_MARKER)).previousRowlitFolder, aside);
    assert.ok(r.notes.some((n) => n.includes('could not carry over the sample diagrams')), r.notes.join('\n'));
    assert.ok(r.notes.some((n) => n.includes(`kept ${aside}`)), r.notes.join('\n'));
  });

  it('a failed DbStudio rename puts the young folder back and uses the DbStudio data for this run', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x);
    const rename = x.renameSync;
    x.renameSync = (a, b) => { if (a === LEGACY) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); rename(a, b); };
    const r = resolveFake(x);
    assert.deepEqual([r.source, r.dir, r.inUse], ['legacy', LEGACY, true]);
    assert.equal(x.readFileSync(join(TARGET, 'settings.json')), '{}', 'young folder restored');
    assert.equal(x.existsSync(aside), false);
    assert.equal(x.existsSync(join(TARGET, dd.MIGRATION_MARKER)), false, 'retried on the next start');
  });

  it('never while DbStudio is running', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x);
    const r = resolveFake(x, { profileInUse: (p) => p === join(LEGACY, 'electron') });
    assert.deepEqual([r.source, r.dir, r.inUse], ['legacy', LEGACY, true]);
    assert.ok(x.existsSync(join(TARGET, 'connections.json')));
    assert.ok(x.existsSync(join(LEGACY, 'secrets.dat')));
  });

  it('unpackaged runs never move anything', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x);
    const before = new Map(x.nodes);
    const r = resolveFake(x, { migrate: false });
    assert.deepEqual([r.source, r.dir], ['current', TARGET]);
    assert.deepEqual(x.nodes, before);
  });

  it('a DbStudio folder with nothing worth moving (only the sample) leaves the young folder alone', () => {
    const x = fakeFs();
    x.file(join(LEGACY, 'settings.json'), '{}');
    x.file(join(LEGACY, 'connections.json'), { version: 1, connections: [
      { id: 'c_s', providerId: 'sqlite', props: { path: join(LEGACY, 'sample', 'shop.sqlite') } },
    ] });
    fakeYoung(x);
    const before = new Map(x.nodes);
    const r = resolveFake(x);
    assert.deepEqual([r.source, r.dir], ['current', TARGET]);
    assert.deepEqual(x.nodes, before);
    assert.ok(r.notes.some((n) => n.includes('nothing to bring over')), r.notes.join('\n'));
  });
});

describe('resolveDataDir: refusals and the marker (in-memory fs)', () => {
  for (const [what, seed] of [
    ['secrets.dat', (x) => x.file(join(TARGET, 'secrets.dat'), 'blob')],
    ['a connection other than the sample', (x) => x.file(join(TARGET, 'connections.json'), { version: 1, connections: [
      { id: 'c_young', providerId: 'sqlite', props: { path: join(TARGET, 'sample', 'shop.sqlite') } },
      { id: 'c_mine', providerId: 'sqlserver', props: { host: 'sql.local' } },
    ] })],
    ['an unreadable connections.json', (x) => x.file(join(TARGET, 'connections.json'), '{nope')],
  ]) {
    it(`a Rowlit folder with ${what} is never replaced or merged`, () => {
      const x = fakeFs();
      fakeLegacy(x);
      fakeYoung(x);
      seed(x);
      const before = new Map(x.nodes);
      const r = resolveFake(x);
      assert.deepEqual([r.source, r.dir], ['current', TARGET]);
      assert.deepEqual(x.nodes, before, 'nothing touched');
      assert.ok(r.notes.some((n) => n.includes('not merged')), r.notes.join('\n'));
    });
  }

  it('the migration marker prevents any later migration (even of a young-looking folder)', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x);
    x.file(join(TARGET, dd.MIGRATION_MARKER), '{}');
    const before = new Map(x.nodes);
    const r = resolveFake(x);
    assert.deepEqual([r.source, r.dir], ['current', TARGET]);
    assert.deepEqual(x.nodes, before);
    assert.deepEqual(r.notes, [`${TARGET}: migration marker present`]);
  });

  it('after a late migration the next start is settled', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeYoung(x);
    resolveFake(x);
    fakeLegacy(x); // e.g. DbStudio reinstalled and started once
    const r = resolveFake(x);
    assert.deepEqual([r.source, r.dir], ['current', TARGET]);
    assert.ok(x.existsSync(join(LEGACY, 'secrets.dat')));
  });
});

describe('resolveDataDir: diagnostics (in-memory fs)', () => {
  it('fresh: says that there is no DbStudio folder and what the Rowlit folder holds', () => {
    const x = fakeFs();
    x.mkdir(ROOT);
    let r = resolveFake(x);
    assert.equal(r.source, 'fresh');
    assert.deepEqual(r.notes, [`no DbStudio folder at ${LEGACY}`, `${TARGET}: absent`]);
    x.mkdir(join(TARGET, 'electron'));
    x.mkdir(join(TARGET, 'logs'));
    r = resolveFake(x);
    assert.equal(r.source, 'fresh');
    assert.match(r.notes[1], /entries \[electron, logs\]; no user data/);
  });

  it('current with a DbStudio folder: entry names and counts, never connection details or secrets', () => {
    const x = fakeFs();
    fakeLegacy(x);
    x.file(join(TARGET, 'secrets.dat'), 'blob');
    x.file(join(TARGET, 'connections.json'), { version: 1, connections: [{ id: 'c1', providerId: 'postgresql', props: { host: 'secret-host', password: 'hunter2' } }] });
    const r = resolveFake(x);
    assert.equal(r.source, 'current');
    const text = r.notes.join('\n');
    assert.ok(text.includes(`${TARGET}: entries [`), text);
    assert.match(text, /Rowlit: entries \[[^\]]*\]; 1 saved connection\(s\), 0 of them the sample; secrets.dat present/);
    assert.match(text, /DbStudio: entries \[[^\]]*connections\.json[^\]]*\]; 1 saved connection\(s\), 0 of them the sample; secrets.dat present/);
    for (const s of ['secret-host', 'hunter2', 'DPAPI-BLOB', 'db.example', 'Prod', 'blob']) assert.equal(text.includes(s), false, s);
  });
});

describe('resolveDataDir: DbStudio data in virtualised AppData (MSIX package storage, in-memory fs)', () => {
  const LOCAL = resolve('/fake-user/AppData/Local');
  const vfs = (pkg) => join(LOCAL, 'Packages', pkg, 'LocalCache', 'Roaming', 'DbStudio');
  const env = { LOCALAPPDATA: LOCAL };

  it('found there when %APPDATA%\\DbStudio is not visible: moved to Rowlit, paths re-pointed (also the merged-view paths)', () => {
    const x = fakeFs();
    x.mkdir(ROOT);
    x.mkdir(join(LOCAL, 'Packages', 'Other_123'));
    // The engine inside the container wrote the merged-view path (%APPDATA%\DbStudio\sample\...).
    fakeLegacy(x, vfs('Claude_abc'), { sample: true, samplePathRoot: LEGACY });
    const seen = [];
    const r = resolveFake(x, { env, platform: 'win32', profileInUse: (p) => { seen.push(p); return false; } });
    assert.deepEqual([r.source, r.dir], ['migrated', TARGET], r.notes.join('\n'));
    assert.deepEqual(seen, [join(vfs('Claude_abc'), 'electron')]);
    assert.equal(x.existsSync(vfs('Claude_abc')), false);
    assert.equal(x.readFileSync(join(TARGET, 'secrets.dat')), 'DPAPI-BLOB');
    assert.equal(x.json(join(TARGET, 'connections.json')).connections[0].props.path, join(TARGET, 'sample', 'shop.sqlite'));
    const marker = x.json(join(TARGET, dd.MIGRATION_MARKER));
    assert.deepEqual([marker.from, marker.virtualised], [vfs('Claude_abc'), true]);
    assert.ok(r.notes.some((n) => n.includes('virtualised AppData')), r.notes.join('\n'));
  });

  it('also recovers a young Rowlit folder', () => {
    const x = fakeFs();
    fakeLegacy(x, vfs('Claude_abc'));
    fakeYoung(x);
    const r = resolveFake(x, { env, platform: 'win32' });
    assert.equal(r.source, 'migrated', r.notes.join('\n'));
    assert.deepEqual(x.json(join(TARGET, 'connections.json')).connections.map((c) => c.id), ['c_pg', 'c_young']);
  });

  it('not used by unpackaged runs, not on other platforms, and not when several packages hold DbStudio data', () => {
    for (const [extra, setup] of [
      [{ migrate: false, platform: 'win32' }, () => {}],
      [{ platform: 'darwin' }, () => {}],
      [{ platform: 'win32' }, (x) => fakeLegacy(x, vfs('Second_xyz'))],
    ]) {
      const x = fakeFs();
      x.mkdir(ROOT);
      fakeLegacy(x, vfs('Claude_abc'));
      setup(x);
      const before = new Map(x.nodes);
      const r = resolveFake(x, { env, ...extra });
      assert.deepEqual([r.source, r.dir], ['fresh', TARGET], JSON.stringify(extra));
      assert.deepEqual(x.nodes, before);
    }
  });

  it('a real %APPDATA%\\DbStudio takes precedence over package storage', () => {
    const x = fakeFs();
    fakeLegacy(x);
    fakeLegacy(x, vfs('Claude_abc'));
    const r = resolveFake(x, { env, platform: 'win32' });
    assert.equal(r.source, 'migrated');
    assert.equal(x.json(join(TARGET, dd.MIGRATION_MARKER)).from, LEGACY);
    assert.ok(x.existsSync(vfs('Claude_abc')), 'untouched');
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
