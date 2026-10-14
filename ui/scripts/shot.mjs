// Zero-dependency screenshot/interaction helper for design and style QA.
// Launches the installed Microsoft Edge headless and drives it over the Chrome DevTools Protocol.
//
// Usage: node scripts/shot.mjs <url> <out.png> [--w 1440] [--h 900] [--theme light|dark] [--steps steps.json]
// steps.json: array of
//   { "click": "css selector" } | { "type": "text" } | { "press": "Enter" | "Escape" | "Tab" | "Control+Enter" | ... }
//   { "wait": 500 } | { "eval": "js expression" } | { "shot": "file.png" }
// Prints JSON { out, errors, evals } where errors are page exceptions / console errors.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = process.env.DBSTUDIO_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [url = 'http://localhost:5173/', out = 'shot.png'] = positional;
const W = Number(opt('w', 1440)), H = Number(opt('h', 900)), theme = opt('theme', 'light');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), 'dbstudio-edge-'));
const edge = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

// Edge forks renderer/GPU/utility processes; killing only the parent leaks them (and they keep the page alive).
function stopEdge() {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
  else edge.kill('SIGKILL');
  for (let i = 0; i < 10; i++) {
    try { rmSync(profile, { recursive: true, force: true }); break; } catch { spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},200)']); }
  }
}
process.on('exit', stopEdge);
process.on('uncaughtException', (e) => { console.error(e); process.exit(1); });

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
}
if (!target) throw new Error('Edge did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map(); const errors = []; const evals = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
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
