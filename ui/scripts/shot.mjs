// Zero-dependency screenshot/interaction helper for design and style QA.
// Launches the installed Microsoft Edge headless and drives it over the Chrome DevTools Protocol.
//
// Usage: node scripts/shot.mjs <url> <out.png> [--w 1440] [--h 900] [--theme light|dark] [--steps steps.json]
//                              [--timeout 120] [--step-timeout 15]
// steps.json: array of
//   { "click": "css selector" } | { "type": "text" } | { "press": "Enter" | "Escape" | "Tab" | "Control+Enter" | ... }
//   { "wait": 500 } | { "eval": "js expression" } | { "shot": "file.png" }
// Prints JSON { out, errors, evals } where errors are page exceptions / console errors.
//
// Edge is never left behind (styles-r2-06): it is stopped on a normal exit, an error, Ctrl+C and SIGTERM/SIGHUP/SIGBREAK,
// when the whole run exceeds --timeout seconds (exit 124), and when one DevTools call gets no answer within
// --step-timeout seconds (exit 1). A small detached reaper also stops it if this process is killed outright
// (SIGKILL, `taskkill /F`, a wrapper's TerminateProcess), which no handler in here can see.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.DBSTUDIO_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [url = 'http://localhost:5173/', out = 'shot.png'] = positional;
const W = Number(opt('w', 1440)), H = Number(opt('h', 900)), theme = opt('theme', 'light');
const seconds = (name, def) => {
  const v = Number(opt(name, def));
  if (!Number.isFinite(v) || v <= 0) { console.error(`--${name} must be a positive number of seconds`); process.exit(2); }
  return v * 1000;
};
const TIMEOUT_MS = seconds('timeout', 120), STEP_MS = seconds('step-timeout', 15);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), 'dbstudio-edge-'));
// POSIX: its own process group, so one kill reaches the renderer/GPU children too (Windows uses taskkill /T).
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore', detached: !WIN });

// Reaper: polls this process and, once it is gone without having cleaned up, kills Edge and removes the profile.
// It watches only this process: Edge's root may already be dead (on Windows Node's job object takes it down with
// this process) while renderer/GPU children it started outside that job live on, so on Windows it also kills every
// msedge.exe whose command line names this run's unique profile directory. A normal exit kills the reaper first.
const REAPER = `
const [ppid, pid, profile, win] = process.argv.slice(1);
const alive = (p) => { try { process.kill(Number(p), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const { spawnSync } = require('node:child_process');
const { rmSync } = require('node:fs');
const { basename } = require('node:path');
// Edge's files stay locked for a moment after the kill: retry the profile removal for up to 10 s.
const removeProfile = (tries) => {
  try { rmSync(profile, { recursive: true, force: true }); process.exit(0); }
  catch { if (tries > 0) setTimeout(() => removeProfile(tries - 1), 250); else process.exit(0); }
};
const poll = setInterval(() => {
  if (alive(ppid)) return;
  clearInterval(poll);
  if (win === '1') {
    if (alive(pid)) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const sweep = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*" + basename(profile) + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', sweep], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-Number(pid), 'SIGKILL'); } catch { try { process.kill(Number(pid), 'SIGKILL'); } catch {} }
  }
  setTimeout(() => removeProfile(40), 250);
}, 1000);`;
let reaper = null;
if (edge.pid) {
  reaper = spawn(process.execPath, ['-e', REAPER, String(process.pid), String(edge.pid), profile, WIN ? '1' : '0'], { stdio: 'ignore', detached: true, windowsHide: true });
  reaper.unref();
}

// Edge forks renderer/GPU/utility processes; killing only the parent leaks them (and they keep the page alive).
let stopped = false;
function stopEdge() {
  if (stopped) return;
  stopped = true;
  try { reaper?.kill(); } catch { /* already gone */ }
  if (edge.pid) {
    if (WIN) spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-edge.pid, 'SIGKILL'); } catch { try { edge.kill('SIGKILL'); } catch { /* already gone */ } } }
  }
  for (let i = 0; i < 10; i++) {
    try { rmSync(profile, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); }
  }
}
function fail(message, code = 1) {
  console.error(message);
  stopEdge();
  process.exit(code);
}
process.on('exit', stopEdge);
process.on('uncaughtException', (e) => fail(e?.stack ?? String(e)));
process.on('unhandledRejection', (e) => fail(e?.stack ?? String(e)));
// Conventional 128 + signal number exit codes (SIGINT 130, SIGTERM 143, SIGHUP 129, SIGBREAK 149).
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  if (constants.signals[sig] !== undefined) process.on(sig, () => fail(`shot.mjs: ${sig}, stopping Edge`, 128 + constants.signals[sig]));
}
edge.on('error', (e) => fail(`shot.mjs: could not start Edge (${EDGE}): ${e.message}`));
setTimeout(() => fail(`shot.mjs: timed out after ${TIMEOUT_MS / 1000} s (--timeout), stopping Edge`, 124), TIMEOUT_MS).unref();

/** Rejects when `p` does not settle within `ms`, naming `what`. */
function within(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(new Error(`shot.mjs: ${what} got no answer within ${ms / 1000} s`)), ms); })])
    .finally(() => clearTimeout(t));
}

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await within(fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()), 2000, '/json/list')).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) throw new Error('Edge did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await within(new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }), STEP_MS, 'the DevTools connection');
let seq = 0; const pending = new Map(); const errors = []; const evals = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
};
// A dead target never answers: fail every outstanding call instead of waiting forever.
ws.onclose = () => {
  for (const { reject } of pending.values()) reject(new Error('shot.mjs: the DevTools connection closed'));
  pending.clear();
};
const send = (method, params = {}) => {
  const id = ++seq;
  const reply = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  return within(reply, STEP_MS, method).finally(() => pending.delete(id));
};
const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
await send('Page.navigate', { url });
for (let i = 0; i < 50; i++) { await sleep(200); if ((await evaluate('document.readyState')) === 'complete') break; }
await sleep(1200);

const KEYS = { Enter: [13, '\r'], Escape: [27], Tab: [9, '\t'], Backspace: [8], Delete: [46], ArrowDown: [40], ArrowUp: [38], ArrowLeft: [37], ArrowRight: [39], F5: [116], F12: [123], Space: [32, ' '] };
async function press(combo) {
  const parts = combo.split('+'); const key = parts.pop();
  const mods = (parts.includes('Alt') ? 1 : 0) | (parts.includes('Control') ? 2 : 0) | (parts.includes('Meta') ? 4 : 0) | (parts.includes('Shift') ? 8 : 0);
  const [code, text] = KEYS[key] ?? [key.toUpperCase().charCodeAt(0), mods ? undefined : key];
  const base = { modifiers: mods, key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
async function click(selector) {
  const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!box) { errors.push(`click: selector not found: ${selector}`); return; }
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
async function shot(file) {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(file, Buffer.from(result.data, 'base64'));
}

for (const s of opt('steps', null) ? JSON.parse(readFileSync(opt('steps'), 'utf8')) : []) {
  if (s.click) await click(s.click);
  else if (s.type !== undefined) await send('Input.insertText', { text: s.type });
  else if (s.press) await press(s.press);
  else if (s.wait) await sleep(s.wait);
  else if (s.eval) evals.push(await evaluate(s.eval));
  else if (s.shot) await shot(s.shot);
  await sleep(120);
}
await shot(out);
ws.close();
console.log(JSON.stringify({ out, errors, evals }));
process.exit(0);
