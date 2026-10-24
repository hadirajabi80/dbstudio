#!/usr/bin/env node
// "Engine native smoke" CI step (docs/PLAN-M2.md D8, 7.6, 10). Starts a PUBLISHED engine binary with `--dev --port 0`,
// waits for its DBSTUDIO_READY line and calls the REST API, so a native library that fails to load (librdkafka, SQLite)
// fails the build before anything is packaged.
//
// Checks, per engine binary:
//   1. GET  /api/v1/providers         -> includes the 7 M2 providers and the 6 Batch 3 ones with their kinds (a subset check).
//   2. GET  /api/v1/kafka/library     -> librdkafka version string (forces the native load: Library.VersionString).
//   3. POST /api/v1/connections/test  -> provider kafka against 127.0.0.1:1: must FAIL with a librdkafka error
//      (error.detail "librdkafka <version>"; the message names the refused/timed-out connection). A packaging problem
//      answers ENGINE_ERROR with detail "librdkafka-missing" instead.
//   4. POST /api/v1/connections/test  -> provider snowflake with a bogus account: must FAIL with a provider error, never
//      ENGINE_ERROR (the driver and its natives load on every platform).
// macOS extras (D8: librdkafka.dylib next to the apphost, signed with the app; likewise libMono.Unix.dylib and
// libsf_mini_core.dylib of Snowflake.Data):
//   - the three dylibs exist next to the engine, `file` shows the expected architecture, `otool -L` lists only system
//     libraries (/usr/lib, /System), for osx-arm64 and (when published) the sibling osx-x64 engine;
//   - osx-x64 runs through the same REST checks when Rosetta is available (`arch -x86_64`), else static checks only;
//   - `codesign --verify --strict` on every one of them inside desktop/dist/**/Rowlit.app (when packaged).
//
// Usage: node scripts/ci/kafka-native-smoke.mjs <path to Rowlit.Engine[.exe]> [--no-mac-extras]
// Exit codes: 0 ok, 1 check failed, 2 usage / engine did not start.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const exe = process.argv[2];
const macExtras = !process.argv.includes('--no-mac-extras');
if (!exe || !existsSync(exe)) {
  console.error(`Usage: node scripts/ci/kafka-native-smoke.mjs <engine executable> (got: ${exe ?? 'nothing'})`);
  process.exit(2);
}

const EXPECTED = [
  ['sqlserver', 'relational'], ['oracle', 'relational'], ['postgresql', 'relational'], ['sqlite', 'relational'],
  ['redis', 'keyvalue'], ['mongodb', 'document'], ['kafka', 'stream'],
  // Batch 3
  ['mysql', 'relational'], ['mariadb', 'relational'], ['clickhouse', 'relational'], ['snowflake', 'relational'],
  ['cassandra', 'relational'], ['elasticsearch', 'search'],
];

/** Native libraries that must sit next to the macOS apphost: librdkafka (Kafka), Mono.Unix and sf_mini_core (Snowflake.Data). */
const MAC_DYLIBS = ['librdkafka.dylib', 'libMono.Unix.dylib', 'libsf_mini_core.dylib'];

class CheckFailed extends Error {}
const fail = (message) => { throw new CheckFailed(message); };

/** Starts one engine, runs the REST checks, stops it. Resolves with a summary line; rejects on failure. */
async function smoke(engine, { launcher = null } = {}) {
  const data = mkdtempSync(join(tmpdir(), 'dbstudio-smoke-'));
  const args = ['--dev', '--port', '0', '--parent-pid', String(process.pid)];
  const child = launcher
    ? spawn(launcher[0], [...launcher.slice(1), engine, ...args], { env: env(data), stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(engine, args, { env: env(data), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', (d) => { output += d; });
  const started = Date.now();
  try {
    const info = await new Promise((res, rej) => {
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d;
        output += d;
        const m = /^DBSTUDIO_READY (\{.*\})$/m.exec(buf);
        if (m) res(JSON.parse(m[1]));
      });
      child.on('exit', (code) => rej(new Error(`engine exited with code ${code} before it was ready`)));
      setTimeout(() => rej(new Error('engine not ready within 60 s')), 60_000);
    });
    const readyMs = Date.now() - started;

    const providers = await api(info, 'GET', '/providers');
    if (providers.status !== 200 || !Array.isArray(providers.json)) fail(`GET /providers answered ${providers.status}`);
    const got = providers.json.map((p) => [p.id, p.kind]);
    // Batch 3 (plan-batch3 WP0): a subset check, so the providers the Batch 3 packages add do not break the smoke test;
    // every expected id must be listed with its kind.
    const missing = EXPECTED.filter(([id, kind]) => !got.some(([gid, gkind]) => gid === id && gkind === kind));
    if (missing.length) fail(`GET /providers: missing ${JSON.stringify(missing)}, got ${JSON.stringify(got)}`);

    const lib = await api(info, 'GET', '/kafka/library');
    if (lib.status !== 200 || !/^\d+\.\d+\.\d+/.test(lib.json?.version ?? '')) {
      fail(`GET /kafka/library: librdkafka did not load (${lib.status} ${JSON.stringify(lib.json)})`);
    }

    const test = await api(info, 'POST', '/connections/test', {
      profile: { id: '', name: 'smoke', providerId: 'kafka', props: { bootstrapServers: '127.0.0.1:1', requestTimeoutMs: 3000 } },
      password: null,
    });
    const err = test.json?.error;
    if (test.status !== 200 || !test.json || test.json.ok !== false || !err) {
      fail(`POST /connections/test (kafka @ 127.0.0.1:1): expected a failed test result, got ${test.status} ${JSON.stringify(test.json)}`);
    }
    if (err.detail === 'librdkafka-missing' || !String(err.detail ?? '').startsWith('librdkafka ')) {
      fail(`POST /connections/test: librdkafka is not usable: ${err.code} ${err.message} (${err.detail})`);
    }
    if (!/refused|timed out|timeout|transport|reach|connect/i.test(err.message ?? '')) {
      fail(`POST /connections/test: unexpected error text from librdkafka: ${err.message}`);
    }
    // Snowflake.Data (and its natives) load on the first connection: a bogus account must answer with a provider error,
    // never an ENGINE_ERROR from a missing library or a crashed driver (the DNS lookup of the account fails quickly).
    const sf = await api(info, 'POST', '/connections/test', {
      profile: { id: '', name: 'smoke', providerId: 'snowflake', props: { account: 'rowlit-smoke-invalid', user: 'X', connectTimeout: 10 } },
      password: 'x',
    });
    const sfErr = sf.json?.error;
    if (sf.status !== 200 || !sf.json || sf.json.ok !== false || !sfErr) {
      fail(`POST /connections/test (snowflake, invalid account): expected a failed test result, got ${sf.status} ${JSON.stringify(sf.json)}`);
    }
    if (sfErr.code === 'ENGINE_ERROR') fail(`POST /connections/test (snowflake): the driver did not load: ${sfErr.code} ${sfErr.message} (${sfErr.detail})`);
    return `${basename(dirname(resolve(engine)))}: ready in ${readyMs} ms, librdkafka ${lib.json.version}`
      + `${lib.json.loadedFrom ? ` (loaded from ${lib.json.loadedFrom})` : ''}; kafka test -> ${err.message}; snowflake test -> ${sfErr.code}`;
  } catch (e) {
    if (output) console.error(`---- engine output (${engine}) ----\n${output.slice(-4000)}`);
    throw e;
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { rmSync(data, { recursive: true, force: true }); } catch { /* engine still closing */ }
  }
}

function env(data) {
  return { ...process.env, DBSTUDIO_DATA_DIR: data, DBSTUDIO_SECRET_STORE: 'memory' };
}

async function api(info, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${info.port}/api/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${info.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
  return { status: res.status, json };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Static checks of the native libraries next to a macOS engine (present, architecture, system dependencies only). */
function checkDylibs(engineDir, arch) {
  const wanted = arch === 'x64' ? 'x86_64' : 'arm64';
  const summary = [];
  for (const name of MAC_DYLIBS) {
    const dylib = join(engineDir, name);
    if (!existsSync(dylib)) fail(`${dylib} is missing (D8: macOS ships ${name} next to the apphost)`);
    const kind = run('file', [dylib]);
    if (!kind.includes(wanted)) fail(`${dylib} is not ${wanted}: ${kind.trim()}`);
    // `otool -L` on a dylib lists its own install name (LC_ID_DYLIB, e.g. /usr/local/lib/librdkafka.1.dylib from the
    // Confluent build, a CI build path for libsf_mini_core) before its dependencies; that id is not a dependency, so
    // take it from `otool -D` and skip it.
    const ownId = run('otool', ['-D', dylib]).split('\n').slice(1).map((l) => l.trim()).find(Boolean);
    const deps = run('otool', ['-L', dylib]).split('\n').slice(1).map((l) => l.trim().split(' ')[0]).filter(Boolean)
      .filter((d) => d !== ownId);
    const foreign = deps.filter((d) => !/^(\/usr\/lib\/|\/System\/|@rpath\/(librdkafka|libMono\.Unix|libsf_mini_core)|@loader_path\/(librdkafka|libMono\.Unix|libsf_mini_core)|librdkafka)/.test(d));
    if (foreign.length > 0) fail(`${dylib} links non-system libraries: ${foreign.join(', ')}`);
    const mb = (statSync(dylib).size / 1024 / 1024).toFixed(1);
    summary.push(`${name} ${deps.length} system deps, ${mb} MB`);
  }
  return `osx-${arch}: ${wanted}; ${summary.join('; ')}`;
}

function findFiles(dir, name, depth = 0, out = []) {
  if (depth > 8 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) findFiles(p, name, depth + 1, out);
    else if (e.name === name) out.push(p);
  }
  return out;
}

function rosettaAvailable() {
  try {
    run('arch', ['-x86_64', '/usr/bin/true']);
    return true;
  } catch {
    return false;
  }
}

const lines = [];
try {
  lines.push(await smoke(exe));

  if (process.platform === 'darwin' && macExtras) {
    const engineDir = dirname(resolve(exe));
    const rid = basename(engineDir); // engine/publish/osx-arm64
    const arch = rid.endsWith('x64') ? 'x64' : 'arm64';
    lines.push(checkDylibs(engineDir, arch));
    const sibling = join(dirname(engineDir), arch === 'arm64' ? 'osx-x64' : 'osx-arm64');
    const siblingExe = join(sibling, 'Rowlit.Engine');
    if (existsSync(siblingExe)) {
      const otherArch = arch === 'arm64' ? 'x64' : 'arm64';
      lines.push(checkDylibs(sibling, otherArch));
      if (otherArch === 'x64' && rosettaAvailable()) lines.push(await smoke(siblingExe, { launcher: ['arch', '-x86_64'] }));
      else if (otherArch === 'x64') lines.push('osx-x64: Rosetta not available on this runner; static checks only (file/otool)');
    }
    // Packaged apps: every librdkafka.dylib must carry a valid signature (signed with the app, hardened runtime).
    const repo = resolve(engineDir, '..', '..', '..');
    const apps = MAC_DYLIBS.flatMap((name) => findFiles(join(repo, 'desktop', 'dist'), name));
    if (apps.length === 0) lines.push('codesign: no packaged Rowlit.app under desktop/dist (skipped)');
    for (const dylib of apps) {
      try {
        run('codesign', ['--verify', '--strict', '--verbose=2', dylib]);
        lines.push(`codesign ok: ${dylib.slice(repo.length + 1)}`);
      } catch (e) {
        fail(`codesign --verify failed for ${dylib}: ${String(e.stderr ?? e.message).trim()}`);
      }
    }
  }
  console.log(`Engine native smoke ok:\n  ${lines.join('\n  ')}`);
  process.exit(0);
} catch (e) {
  if (lines.length) console.error(`  passed so far:\n  ${lines.join('\n  ')}`);
  const message = e instanceof Error ? e.message : String(e);
  console.error(`Engine native smoke failed: ${message}`);
  // On GitHub Actions also emit an annotation, readable from the API without downloading the job log.
  if (process.env.GITHUB_ACTIONS) {
    const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
    console.log(`::error title=Engine native smoke::${esc(`${message}\npassed so far:\n${lines.join('\n')}`.slice(0, 4000))}`);
  }
  process.exit(e instanceof CheckFailed ? 1 : 2);
}
