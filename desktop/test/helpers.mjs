import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fakeEngine = join(desktopRoot, 'test', 'fake-engine.mjs');

export function isAlive(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    // process.kill(pid, 0) can report a zombie handle as alive on Windows; ask tasklist instead.
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    return r.stdout.includes(`"${pid}"`);
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitFor(pred, timeoutMs = 5000, stepMs = 100) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
