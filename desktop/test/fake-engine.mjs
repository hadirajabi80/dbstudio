#!/usr/bin/env node
// Stand-in for DbStudio.Host used to test the Electron lifecycle without .NET.
// Mirrors the real handshake: prints exactly one `DBSTUDIO_READY {"port":N,"token":"..."}` stdout line,
// serves GET /api/v1/health with Bearer auth and CORS for dbstudio://app (and localhost:5173 with --dev).
//
// Engine flags: --port N, --token T, --dev, --parent-pid PID
// Test-only flags:
//   --ready-delay MS     wait before printing READY
//   --never-ready        never print READY (timeout path)
//   --exit-before-ready  exit with code 3 instead of printing READY
//   --exit-after MS      exit with code 7 MS after READY (crash path)
//   --spawn-child        spawn a grandchild process (tree-kill check); prints FAKE_CHILD_PID on stderr
//   --noisy              print some log lines before READY (like `dotnet run` build output)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dev = flag('--dev');
const token = opt('--token') ?? randomBytes(32).toString('base64url');
const port = Number(opt('--port') ?? 0);
const parentPid = opt('--parent-pid') ? Number(opt('--parent-pid')) : undefined;
const allowedOrigins = new Set(['dbstudio://app', ...(dev ? ['http://localhost:5173'] : [])]);

if (flag('--spawn-child')) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  process.stderr.write(`FAKE_CHILD_PID ${child.pid}\n`);
}

if (parentPid) {
  // Same contract as the real engine: exit when the parent disappears.
  setInterval(() => {
    try { process.kill(parentPid, 0); } catch { process.exit(0); }
  }, 1000).unref();
}

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid token' } }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '0.0.0-fake', pid: process.pid, dev }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: req.url } }));
});

server.listen(port, '127.0.0.1', () => {
  const actualPort = server.address().port;
  if (flag('--noisy')) {
    process.stdout.write('  Determining projects to restore...\n  DbStudio.Host -> bin\\Debug\\net10.0\\DbStudio.Host.dll\n');
    process.stderr.write('warn: something harmless on stderr\n');
  }
  if (flag('--never-ready')) return;
  if (flag('--exit-before-ready')) { process.stderr.write('fatal: simulated startup failure\n'); process.exit(3); }
  setTimeout(() => {
    process.stdout.write(`DBSTUDIO_READY ${JSON.stringify({ port: actualPort, token })}\n`);
    process.stdout.write('info: engine started\n');
    const exitAfter = opt('--exit-after');
    if (exitAfter) setTimeout(() => process.exit(7), Number(exitAfter));
  }, Number(opt('--ready-delay') ?? 0));
});
