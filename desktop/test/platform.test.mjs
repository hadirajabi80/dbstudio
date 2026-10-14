// Per-OS behaviour (WP-K): engine binary resolution, macOS process-group kill, window chrome and lifecycle rules.
// Everything platform-specific is injected, so the macOS paths are exercised on Windows CI too.
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { desktopRoot, fakeEngine, isAlive, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const ep = require(join(desktopRoot, 'out', 'lib', 'engine-process.js'));
const pf = require(join(desktopRoot, 'out', 'lib', 'platform.js'));

const base = { isPackaged: true, repoRoot: '/src/DbStudio', parentPid: 42, env: {}, devServer: false };

describe('engine binary per platform', () => {
  it('names: .exe on Windows only', () => {
    assert.deepEqual(ep.engineExeCandidates('win32'), ['DbStudio.Engine.exe', 'DbStudio.Host.exe']);
    assert.deepEqual(ep.engineExeCandidates('darwin'), ['DbStudio.Engine', 'DbStudio.Host']);
    assert.deepEqual(ep.engineExeCandidates('linux'), ['DbStudio.Engine', 'DbStudio.Host']);
  });

  it('macOS packaged: Contents/Resources/engine/DbStudio.Engine, made executable', () => {
    const chmodded = [];
    const l = ep.resolveEngineLaunch({
      ...base,
      platform: 'darwin',
      resourcesPath: '/Applications/DbStudio.app/Contents/Resources',
      exists: (p) => /DbStudio\.Engine$/.test(p),
      makeExecutable: (p) => chmodded.push(p),
    });
    assert.equal(l.kind, 'spawn');
    assert.match(l.spec.command, /Contents[\\/]Resources[\\/]engine[\\/]DbStudio\.Engine$/);
    assert.match(l.spec.cwd, /Contents[\\/]Resources[\\/]engine$/);
    assert.deepEqual(l.spec.args, ['--parent-pid', '42']);
    assert.deepEqual(chmodded, [l.spec.command]);
  });

  it('macOS packaged: falls back to the Host apphost name, and to the first name when nothing exists', () => {
    const opts = { ...base, platform: 'darwin', resourcesPath: '/r', makeExecutable: () => {} };
    assert.match(ep.resolveEngineLaunch({ ...opts, exists: (p) => p.endsWith('DbStudio.Host') }).spec.command, /DbStudio\.Host$/);
    assert.match(ep.resolveEngineLaunch({ ...opts, exists: () => false }).spec.command, /DbStudio\.Engine$/);
  });

  it('Windows packaged is unchanged and never chmods', () => {
    const l = ep.resolveEngineLaunch({ ...base, platform: 'win32', resourcesPath: 'C:\\app\\resources', exists: () => true });
    assert.match(l.spec.command, /resources[\\/]engine[\\/]DbStudio\.Engine\.exe$/);
  });

  it('DBSTUDIO_ENGINE_PATH is made executable too', () => {
    const seen = [];
    ep.resolveEngineLaunch({ ...base, isPackaged: false, platform: 'darwin', resourcesPath: '/r', env: { DBSTUDIO_ENGINE_PATH: '/x/DbStudio.Engine' }, makeExecutable: (p) => seen.push(p) });
    assert.equal(seen.length, 1);
    assert.match(seen[0], /DbStudio\.Engine$/);
  });

  it('ensureExecutable adds the x bits on POSIX and is a no-op on Windows', { skip: process.platform === 'win32' && 'POSIX file modes' }, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dbstudio-x-')), 'DbStudio.Engine');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    assert.throws(() => accessSync(file, constants.X_OK));
    ep.ensureExecutable(file, process.platform);
    accessSync(file, constants.X_OK);
    ep.ensureExecutable(join(file, 'missing')); // never throws
  });
});

describe('process tree kill', () => {
  const recorder = (failFor = () => false) => {
    const calls = [];
    const kill = (pid, sig) => {
      calls.push([pid, sig]);
      if (failFor(pid, sig)) { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; }
    };
    return { calls, kill };
  };

  it('macOS: SIGKILL goes to the process group (kill -KILL -pid)', () => {
    const r = recorder();
    ep.killProcessTree(1234, { platform: 'darwin', kill: r.kill, taskkill: () => assert.fail('no taskkill on macOS') });
    assert.deepEqual(r.calls, [[-1234, 'SIGKILL']]);
  });

  it('macOS: falls back to the pid when the group is gone (unless groupOnly), and reports a vanished process', () => {
    const g = recorder((pid) => pid < 0);
    assert.equal(ep.signalProcessTree(77, 'SIGKILL', { kill: g.kill, groupOnly: true }), false);
    assert.deepEqual(g.calls, [[-77, 'SIGKILL']]);
    const r = recorder((pid) => pid < 0);
    assert.equal(ep.signalProcessTree(77, 'SIGTERM', { kill: r.kill }), true);
    assert.deepEqual(r.calls, [[-77, 'SIGTERM'], [77, 'SIGTERM']]);
    const gone = recorder(() => true);
    assert.equal(ep.signalProcessTree(77, 0, { kill: gone.kill }), false);
    assert.equal(ep.signalProcessTree(0, 'SIGTERM', { kill: () => assert.fail() }), false);
  });

  it('Windows: taskkill /T /F, no signals', () => {
    const seen = [];
    ep.killProcessTree(99, { platform: 'win32', taskkill: (pid) => seen.push(pid), kill: () => assert.fail('no signals on Windows') });
    assert.deepEqual(seen, [99]);
  });

  const spec = () => ({ command: process.execPath, args: [fakeEngine, '--parent-pid', String(process.pid)], readyTimeoutMs: 10_000, description: 'fake' });

  it('macOS stopAndWait: SIGTERM to the group first; no SIGKILL wait when the engine exits in time', async () => {
    const order = [];
    const p = new ep.EngineProcess({
      spec: spec(),
      platform: 'darwin',
      killGraceMs: 5_000,
      // Simulate an engine that handles SIGTERM by exiting (uses the real kill so the process really ends).
      signalTree: (pid, sig) => { order.push(sig); ep.killProcessTree(pid); return true; },
      killTree: () => assert.fail('no SIGKILL when SIGTERM worked'),
      reapGroup: () => order.push('REAP'),
    });
    await p.start();
    const pid = p.pid;
    const t0 = Date.now();
    await p.stopAndWait();
    assert.ok(Date.now() - t0 < 4_000, 'did not wait for the grace period');
    assert.deepEqual(order, ['SIGTERM', 'REAP']); // the group-only reap takes down leftovers in the group
    assert.ok(await waitFor(() => !isAlive(pid)));
  });

  it('macOS stopAndWait: escalates to SIGKILL after the grace period when SIGTERM is ignored', async () => {
    const order = [];
    const p = new ep.EngineProcess({
      spec: spec(),
      platform: 'darwin',
      killGraceMs: 400,
      signalTree: (_pid, sig) => { order.push(sig); return true; }, // engine ignores it
      killTree: (pid) => { order.push('KILL'); ep.killProcessTree(pid); },
    });
    const exits = [];
    p.on('exit', (e) => exits.push(e));
    await p.start();
    const t0 = Date.now();
    await p.stopAndWait(5_000);
    assert.ok(Date.now() - t0 >= 350, 'waited for the grace period');
    assert.deepEqual(order, ['SIGTERM', 'KILL']);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].expected, true);
  });

  it('Windows stopAndWait never signals', async () => {
    const p = new ep.EngineProcess({ spec: spec(), platform: 'win32', signalTree: () => assert.fail('no SIGTERM on Windows') });
    await p.start();
    await p.stopAndWait();
    assert.equal(p.isRunning, false);
  });
});

describe('window chrome and lifecycle', () => {
  it('desktopOs narrows process.platform', () => {
    assert.equal(pf.desktopOs('darwin'), 'darwin');
    assert.equal(pf.desktopOs('win32'), 'win32');
    assert.equal(pf.desktopOs('linux'), 'linux');
    assert.equal(pf.desktopOs('freebsd'), 'linux');
  });

  it('macOS keeps running with no windows; Windows and Linux quit', () => {
    assert.equal(pf.quitWhenAllWindowsClosed('darwin'), false);
    assert.equal(pf.quitWhenAllWindowsClosed('win32'), true);
    assert.equal(pf.quitWhenAllWindowsClosed('linux'), true);
  });

  it('macOS: hiddenInset title bar with the traffic lights centred in the 40 px top bar', () => {
    const c = pf.windowChrome('darwin');
    assert.equal(c.titleBarStyle, 'hiddenInset');
    assert.equal(c.trafficLightPosition.x, 14);
    assert.equal(c.trafficLightPosition.y, 13);
    assert.deepEqual(pf.windowChrome('win32'), {}, 'Windows keeps the native frame');
    assert.deepEqual(pf.windowChrome('linux'), {});
  });

  it('html classes and CSS variables for the renderer', () => {
    assert.deepEqual(pf.htmlPlatformClasses('darwin'), ['platform-darwin', 'titlebar-inset']);
    assert.deepEqual(pf.htmlPlatformClasses('win32'), ['platform-win32']);
    assert.equal(pf.htmlPlatformVars('darwin')['--titlebar-inset-left'], '78px');
    assert.equal(pf.htmlPlatformVars('win32')['--titlebar-inset-left'], '0px');
  });

});
