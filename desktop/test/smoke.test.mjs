// End-to-end smoke test of the real Electron app with the fake engine (DBSTUDIO_SMOKE=1, see src/main/smoke.ts).
// Covers: dbstudio:// protocol + MIME, sandboxed preload bridge, READY handshake, authenticated CORS fetch from
// the renderer, CSP (no eval), IPC validation, workspace round trip, crash -> restart -> onEngineRestarted,
// and quit leaving no engine (or engine child) process behind.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { desktopRoot, fakeEngine, isAlive, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // path to electron.exe when required from Node

it('electron app: bridge, engine handshake, CSP, restart, clean quit', { timeout: 120_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dbstudio-smoke-'));
  const env = {
    ...process.env,
    DBSTUDIO_SMOKE: '1',
    DBSTUDIO_DATA_DIR: dataDir,
    DBSTUDIO_UI_DIR: join(desktopRoot, 'test', 'fixture-ui'),
    DBSTUDIO_ENGINE_CMD: `"${process.execPath}" "${fakeEngine}" --spawn-child --noisy`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DBSTUDIO_DEV_URL;
  delete env.DBSTUDIO_ENGINE_URL;

  const child = spawn(electronBin, [desktopRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((r) => child.on('exit', r));

  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('DBSTUDIO_SMOKE_RESULT '));
  assert.ok(line, `no smoke result (exit ${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const r = JSON.parse(line.slice('DBSTUDIO_SMOKE_RESULT '.length));
  assert.equal(r.error, undefined, r.error);

  assert.equal(r.hasBridge, true);
  assert.deepEqual(r.keys, [
    'appVersion', 'getEngineInfo', 'loadWorkspace', 'onEngineRestarted', 'onMenuCommand', 'openExternal', 'platform',
    'readTextFile', 'saveWorkspace', 'setTitle', 'setZoomFactor', 'showOpenDialog', 'showSaveDialog', 'writeTextFile',
  ]);
  assert.equal(r.platform, 'electron');
  // OS info outside the bridge contract (WP-K): window.dbstudioPlatform and <html class="platform-<os>">.
  const os = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
  assert.equal(r.osPlatform, os);
  assert.ok(r.htmlClass.split(' ').includes(`platform-${os}`), r.htmlClass);
  assert.match(r.appVersion, /^\d+\.\d+\.\d+/);
  assert.equal(r.origin, 'dbstudio://app');
  assert.equal(r.tokenInUrl, false);
  assert.equal(r.health.status, 'ok');
  assert.equal(r.unauthorizedStatus, 401);
  assert.equal(r.evalBlocked, true, 'CSP must block eval');
  assert.equal(r.openExternalFileRejected, true);
  assert.equal(r.readRelativeRejected, true);
  assert.deepEqual(r.workspace, { tabs: [{ id: 1, text: 'select 1' }] });
  assert.equal(r.moduleWorker, 42, 'module worker from dbstudio://app');
  assert.equal(r.blobWorker, 42, 'blob: worker (CSP worker-src)');
  assert.equal(r.cssLoaded, true, 'stylesheet served with text/css');
  assert.equal(r.spaFallback, '200 text/html; charset=utf-8');
  assert.equal(r.missingAsset, 404);
  assert.equal(r.traversal, 404);
  assert.ok(existsSync(join(dataDir, 'workspace.json')));

  assert.equal(r.healthAfterRestart.status, 'ok');
  assert.notEqual(r.healthAfterRestart.pid, r.health.pid, 'a new engine process answered after the restart');
  const [firstPid, secondPid] = r.enginePids;
  assert.ok(firstPid && secondPid && firstPid !== secondPid);

  const log = readFileSync(join(dataDir, 'logs', 'engine-process.log'), 'utf8');
  assert.doesNotMatch(log, new RegExp(`"token":"(?!<redacted>)`), 'token must not be logged');
  const childPids = [...log.matchAll(/FAKE_CHILD_PID (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(childPids.length, 2);
  for (const pid of [firstPid, secondPid, ...childPids]) {
    assert.ok(await waitFor(() => !isAlive(pid), 5000), `process ${pid} survived the quit`);
  }
});

it('electron app: engine that never becomes ready hits the timeout path and is killed', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dbstudio-smoke-'));
  const env = {
    ...process.env,
    DBSTUDIO_SMOKE: '1',
    DBSTUDIO_DATA_DIR: dataDir,
    DBSTUDIO_UI_DIR: join(desktopRoot, 'test', 'fixture-ui'),
    DBSTUDIO_ENGINE_CMD: `"${process.execPath}" "${fakeEngine}" --never-ready --spawn-child`,
    DBSTUDIO_ENGINE_TIMEOUT_MS: '2000',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.DBSTUDIO_DEV_URL;
  delete env.DBSTUDIO_ENGINE_URL;
  const child = spawn(electronBin, [desktopRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  await new Promise((r) => child.on('exit', r));
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('DBSTUDIO_SMOKE_RESULT '));
  assert.ok(line, stdout);
  const r = JSON.parse(line.slice('DBSTUDIO_SMOKE_RESULT '.length));
  assert.equal(r.startFailed, true);
  assert.match(r.error, /did not report ready within 2 s/);
  assert.match(r.errorPage, /^The DbStudio engine could not be started \| \d+/);
  const log = readFileSync(join(dataDir, 'logs', 'engine-process.log'), 'utf8');
  const childPids = [...log.matchAll(/FAKE_CHILD_PID (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(childPids.length, 1);
  assert.ok(await waitFor(() => !isAlive(childPids[0]), 5000), 'engine child survived the timeout kill');
});
