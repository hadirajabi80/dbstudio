// Lifecycle tests for src/main/engine-process.ts against test/fake-engine.mjs (no Electron, no .NET).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { desktopRoot, fakeEngine, isAlive, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const ep = require(join(desktopRoot, 'out', 'lib', 'engine-process.js'));

const spec = (extra = [], readyTimeoutMs = 10_000) => ({
  command: process.execPath,
  args: [fakeEngine, ...extra, '--parent-pid', String(process.pid)],
  readyTimeoutMs,
  description: 'fake engine',
});

async function health(info) {
  const r = await fetch(`${info.baseUrl}/api/v1/health`, { headers: { Authorization: `Bearer ${info.token}` } });
  return { status: r.status, body: await r.json() };
}

describe('parseReadyLine', () => {
  it('parses the handshake', () => {
    assert.deepEqual(ep.parseReadyLine('DBSTUDIO_READY {"port":51234,"token":"abc"}'), { port: 51234, token: 'abc' });
    assert.deepEqual(ep.parseReadyLine('\uFEFFDBSTUDIO_READY {"port":1,"token":"t"}\r'), { port: 1, token: 't' });
  });
  it('rejects anything else', () => {
    for (const line of [
      '', 'hello', 'DBSTUDIO_READY', 'DBSTUDIO_READY {', 'DBSTUDIO_READY {"port":0,"token":"x"}',
      'DBSTUDIO_READY {"port":70000,"token":"x"}', 'DBSTUDIO_READY {"port":"80","token":"x"}',
      'DBSTUDIO_READY {"port":80,"token":""}', 'DBSTUDIO_READY {"port":80}', 'info: DBSTUDIO_READY {"port":80,"token":"x"}',
      'DBSTUDIO_READY null', 'DBSTUDIO_READY {"port":1.5,"token":"x"}',
    ]) assert.equal(ep.parseReadyLine(line), null, line);
  });
});

describe('parseCommandLine', () => {
  it('splits with quotes and keeps backslashes', () => {
    assert.deepEqual(ep.parseCommandLine('node "C:\\Program Files\\x\\fake.mjs" --a  b'), ['node', 'C:\\Program Files\\x\\fake.mjs', '--a', 'b']);
    assert.deepEqual(ep.parseCommandLine('a "" "say ""hi"""'), ['a', '', 'say "hi"']);
    assert.throws(() => ep.parseCommandLine('a "b'));
  });
});

describe('resolveEngineLaunch', () => {
  const base = { isPackaged: false, resourcesPath: 'C:\\app\\resources', repoRoot: 'E:\\DbStudio', parentPid: 42, env: {}, devServer: false };
  it('dev: dotnet run on the Host project with --parent-pid and a long timeout', () => {
    const l = ep.resolveEngineLaunch(base);
    assert.equal(l.kind, 'spawn');
    assert.equal(l.spec.command, 'dotnet');
    assert.deepEqual(l.spec.args.slice(0, 1), ['run']);
    assert.ok(l.spec.args.includes('--no-launch-profile'));
    assert.deepEqual(l.spec.args.slice(-3), ['--', '--parent-pid', '42']);
    assert.ok(l.spec.readyTimeoutMs >= 60_000);
  });
  it('packaged: resources/engine exe, 15 s timeout, falls back to the Host exe name', () => {
    const l = ep.resolveEngineLaunch({ ...base, isPackaged: true, exists: (p) => p.endsWith('DbStudio.Host.exe') });
    assert.match(l.spec.command, /resources[\\/]engine[\\/]DbStudio\.Host\.exe$/);
    assert.equal(l.spec.readyTimeoutMs, 15_000);
    const l2 = ep.resolveEngineLaunch({ ...base, isPackaged: true, exists: () => true });
    assert.match(l2.spec.command, /DbStudio\.Engine\.exe$/);
  });
  it('DBSTUDIO_ENGINE_CMD override, plus --dev when the UI comes from Vite', () => {
    const l = ep.resolveEngineLaunch({ ...base, devServer: true, env: { DBSTUDIO_ENGINE_CMD: 'node fake.mjs --noisy', DBSTUDIO_ENGINE_TIMEOUT_MS: '3000' } });
    assert.equal(l.spec.command, 'node');
    assert.deepEqual(l.spec.args, ['fake.mjs', '--noisy', '--parent-pid', '42', '--dev']);
    assert.equal(l.spec.readyTimeoutMs, 3000);
  });
  it('external engine (scripts/dev.ps1)', () => {
    const l = ep.resolveEngineLaunch({ ...base, env: { DBSTUDIO_ENGINE_URL: 'http://127.0.0.1:5121/', DBSTUDIO_ENGINE_TOKEN: 'dev-token' } });
    assert.deepEqual(l, { kind: 'external', info: { baseUrl: 'http://127.0.0.1:5121', token: 'dev-token' } });
    assert.throws(() => ep.resolveEngineLaunch({ ...base, env: { DBSTUDIO_ENGINE_URL: 'http://evil.example:5121', DBSTUDIO_ENGINE_TOKEN: 't' } }));
    assert.throws(() => ep.resolveEngineLaunch({ ...base, env: { DBSTUDIO_ENGINE_URL: 'http://127.0.0.1:5121' } }));
  });
});

describe('EngineProcess', () => {
  it('parses READY among noisy output, serves health, and kills the whole tree on stop', async () => {
    const p = new ep.EngineProcess({ spec: spec(['--noisy', '--spawn-child', '--ready-delay', '200']) });
    const lines = [];
    p.on('output', (s, l) => lines.push(`${s}:${l}`));
    const info = await p.start();
    assert.match(info.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(info.token.length >= 32);
    const h = await health(info);
    assert.equal(h.status, 200);
    assert.equal(h.body.status, 'ok');
    // token never logged
    assert.ok(lines.some((l) => l.includes('<redacted>')));
    assert.ok(!lines.some((l) => l.includes(info.token)));
    const childPid = Number(lines.map((l) => /FAKE_CHILD_PID (\d+)/.exec(l)?.[1]).find(Boolean));
    assert.ok(childPid > 0, 'grandchild pid reported');
    assert.ok(isAlive(p.pid) && isAlive(childPid));

    const exits = [];
    p.on('exit', (e) => exits.push(e));
    await p.stopAndWait();
    assert.equal(exits.length, 1);
    assert.equal(exits[0].expected, true);
    assert.equal(exits[0].wasReady, true);
    assert.ok(await waitFor(() => !isAlive(p.pid)), 'engine gone');
    assert.ok(await waitFor(() => !isAlive(childPid)), 'grandchild gone (tree kill)');
  });

  it('times out when READY never comes, and kills the process', async () => {
    const p = new ep.EngineProcess({ spec: spec(['--never-ready'], 1500) });
    const t0 = Date.now();
    await assert.rejects(p.start(), (e) => e instanceof ep.EngineStartError && e.kind === 'timeout');
    assert.ok(Date.now() - t0 >= 1400);
    assert.ok(await waitFor(() => !isAlive(p.pid)), 'timed-out engine killed');
  });

  it('reports an exit before READY with the tail of its output', async () => {
    const p = new ep.EngineProcess({ spec: spec(['--exit-before-ready']) });
    await assert.rejects(p.start(), (e) => e.kind === 'exit' && e.output.some((l) => l.includes('simulated startup failure')));
  });

  it('reports a spawn failure', async () => {
    const p = new ep.EngineProcess({ spec: { command: 'C:\\definitely\\missing\\DbStudio.Engine.exe', args: [], readyTimeoutMs: 5000, description: 'missing' } });
    await assert.rejects(p.start(), (e) => e.kind === 'spawn');
  });

  it('flags an unexpected exit after READY', async () => {
    const p = new ep.EngineProcess({ spec: spec(['--exit-after', '200']) });
    const exit = new Promise((r) => p.on('exit', r));
    await p.start();
    const e = await exit;
    assert.equal(e.expected, false);
    assert.equal(e.wasReady, true);
    assert.equal(e.code, 7);
  });
});

describe('EngineSupervisor', () => {
  it('restarts after a crash when the user agrees, and hands out fresh info', async () => {
    const launch = { kind: 'spawn', spec: spec(['--spawn-child']) };
    const events = [];
    let restarted;
    const restartedP = new Promise((r) => { restarted = r; });
    const sup = new ep.EngineSupervisor(launch, {
      askRestart: async (exit) => { events.push(['ask', exit.code]); return true; },
      onRestarted: (info) => { events.push(['restarted']); restarted(info); },
      onStartFailed: (e) => events.push(['failed', e.message]),
      onGaveUp: () => events.push(['gaveUp']),
    });
    const first = await sup.start();
    assert.deepEqual(await sup.whenReady(), first);
    const firstPid = sup.pid;

    sup.simulateCrash();
    const second = await restartedP;
    assert.notEqual(second.token, first.token);
    assert.deepEqual(await sup.whenReady(), second);
    assert.equal((await health(second)).status, 200);
    assert.ok(!isAlive(firstPid));
    assert.equal(events[0][0], 'ask');
    assert.deepEqual(events.at(-1), ['restarted']);

    const secondPid = sup.pid;
    sup.shutdown();
    assert.ok(await waitFor(() => !isAlive(secondPid)));
    assert.ok(!events.some((e) => e[0] === 'failed'));
  });

  it('gives up when the user declines', async () => {
    let gaveUp;
    const done = new Promise((r) => { gaveUp = r; });
    const sup = new ep.EngineSupervisor({ kind: 'spawn', spec: spec(['--exit-after', '150']) }, {
      askRestart: async () => false,
      onRestarted: () => assert.fail('must not restart'),
      onStartFailed: () => assert.fail('must not fail'),
      onGaveUp: () => gaveUp(),
    });
    await sup.start();
    await done;
  });

  it('rejects waiting callers on a failed start, then succeeds on retry', async () => {
    let fail = true;
    const failures = [];
    const sup = new ep.EngineSupervisor({ kind: 'spawn', spec: spec() }, {
      askRestart: async () => true, onRestarted() {}, onGaveUp() {},
      onStartFailed: (e) => failures.push(e.kind),
    }, (s) => new ep.EngineProcess({ spec: fail ? { ...s, args: [fakeEngine, '--exit-before-ready'] } : s }));
    const waiting = sup.whenReady();
    await assert.rejects(sup.start());
    await assert.rejects(waiting);
    assert.deepEqual(failures, ['exit']);
    fail = false;
    const info = await sup.start();
    assert.deepEqual(await sup.whenReady(), info);
    sup.shutdown();
  });

  it('a manual restart invalidates the previous info', async () => {
    const sup = new ep.EngineSupervisor({ kind: 'spawn', spec: spec() }, {
      askRestart: async () => assert.fail('a manual restart is not a crash'), onRestarted() {}, onGaveUp() {}, onStartFailed() {},
    });
    const a = await sup.start();
    const aPid = sup.pid;
    const b = await sup.start();
    assert.notEqual(a.token, b.token);
    assert.deepEqual(await sup.whenReady(), b);
    assert.ok(await waitFor(() => !isAlive(aPid)));
    sup.shutdown();
  });

  it('external mode never spawns', async () => {
    const info = { baseUrl: 'http://127.0.0.1:5121', token: 'dev-token' };
    const sup = new ep.EngineSupervisor({ kind: 'external', info }, { askRestart: async () => true, onRestarted() {}, onGaveUp() {}, onStartFailed() {} },
      () => assert.fail('spawned'));
    assert.deepEqual(await sup.start(), info);
    assert.deepEqual(await sup.whenReady(), info);
    assert.equal(sup.pid, undefined);
  });
});
