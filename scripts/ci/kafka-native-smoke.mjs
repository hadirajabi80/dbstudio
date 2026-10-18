#!/usr/bin/env node
// "Engine native smoke" CI step (docs/PLAN-M2.md D8, 7.6, 10). Starts a PUBLISHED engine binary with `--dev --port 0`,
// waits for its DBSTUDIO_READY line and calls the REST API, so a native library that fails to load (librdkafka, SQLite)
// fails the build before anything is packaged.
//
// M2-0 wires the step and checks GET /api/v1/providers (7 providers with kinds). M2-K extends this script with the
// Kafka part: POST /api/v1/connections/test with provider "kafka" against 127.0.0.1:1, expecting a librdkafka
// "Connection refused"/timeout error (which proves librdkafka.dll/.dylib loaded), and the osx-x64 file/otool checks.
//
// Usage: node scripts/ci/kafka-native-smoke.mjs <path to DbStudio.Engine[.exe]>
// Exit codes: 0 ok, 1 check failed, 2 usage / engine did not start.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2];
if (!exe || !existsSync(exe)) {
  console.error(`Usage: node scripts/ci/kafka-native-smoke.mjs <engine executable> (got: ${exe ?? 'nothing'})`);
  process.exit(2);
}

const EXPECTED = [
  ['sqlserver', 'relational'], ['oracle', 'relational'], ['postgresql', 'relational'], ['sqlite', 'relational'],
  ['redis', 'keyvalue'], ['mongodb', 'document'], ['kafka', 'stream'],
];

const data = mkdtempSync(join(tmpdir(), 'dbstudio-smoke-'));
const child = spawn(exe, ['--dev', '--port', '0', '--parent-pid', String(process.pid)], {
  env: { ...process.env, DBSTUDIO_DATA_DIR: data, DBSTUDIO_SECRET_STORE: 'memory' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stderr.on('data', (d) => { output += d; });

function stop(code, message) {
  if (message) (code === 0 ? console.log : console.error)(message);
  if (code !== 0 && output) console.error(`---- engine output ----\n${output.slice(-4000)}`);
  child.kill();
  setTimeout(() => {
    try { rmSync(data, { recursive: true, force: true }); } catch { /* engine still closing */ }
    process.exit(code);
  }, 500);
}

const ready = new Promise((resolve, reject) => {
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    output += d;
    const m = /^DBSTUDIO_READY (\{.*\})$/m.exec(buf);
    if (m) resolve(JSON.parse(m[1]));
  });
  child.on('exit', (code) => reject(new Error(`engine exited with code ${code} before it was ready`)));
  setTimeout(() => reject(new Error('engine not ready within 60 s')), 60_000);
});

async function api(info, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${info.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

try {
  const info = await ready;
  const providers = await api(info, 'GET', '/providers');
  if (providers.status !== 200 || !Array.isArray(providers.json)) stop(1, `GET /providers answered ${providers.status}`);
  const got = providers.json.map((p) => [p.id, p.kind]);
  if (JSON.stringify(got) !== JSON.stringify(EXPECTED)) {
    stop(1, `GET /providers: expected ${JSON.stringify(EXPECTED)}, got ${JSON.stringify(got)}`);
  } else {
    // ---- M2-K: Kafka native load check goes here (POST /connections/test, provider kafka, 127.0.0.1:1).
    stop(0, `Engine native smoke ok: ${got.map(([id]) => id).join(', ')}`);
  }
} catch (e) {
  stop(2, `Engine native smoke failed: ${e instanceof Error ? e.message : String(e)}`);
}
