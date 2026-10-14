// Self-test used by test/smoke.test.mjs (DBSTUDIO_SMOKE=1). Drives the real app end to end:
// bridge shape, engine handshake + authenticated fetch from the dbstudio:// origin, CSP, IPC
// validation, workspace round trip, then kills the engine and verifies the restart path.
import { app, type BrowserWindow } from 'electron';
import type { EngineSupervisor } from './engine-process';

const PHASE1 = `(async () => {
  const b = window.dbstudio;
  const r = { hasBridge: !!b, keys: b ? Object.keys(b).sort() : [], platform: b && b.platform,
              appVersion: b && b.appVersion, url: location.href, origin: location.origin };
  const info = await b.getEngineInfo();
  r.baseUrl = info.baseUrl;
  r.osPlatform = window.dbstudioPlatform && window.dbstudioPlatform.platform;
  r.htmlClass = document.documentElement.className;
  r.tokenInUrl = location.href.includes(info.token);
  r.health = await fetch(info.baseUrl + '/api/v1/health', { headers: { Authorization: 'Bearer ' + info.token } }).then((x) => x.json());
  r.unauthorizedStatus = await fetch(info.baseUrl + '/api/v1/health').then((x) => x.status);
  try { eval('1'); r.evalBlocked = false; } catch { r.evalBlocked = true; }
  r.openExternalFileRejected = await b.openExternal('file:///C:/Windows/notepad.exe').then(() => false, () => true);
  r.readRelativeRejected = await b.readTextFile('relative.sql').then(() => false, () => true);
  await b.saveWorkspace({ tabs: [{ id: 1, text: 'select 1' }] });
  r.workspace = await b.loadWorkspace();
  const tryWorker = (make) => new Promise((res) => {
    const t = setTimeout(() => res('timeout'), 3000);
    try {
      const w = make();
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); res(e.data); };
      w.onerror = (e) => { clearTimeout(t); res('error: ' + (e.message || 'failed')); };
      w.postMessage(21);
    } catch (e) { clearTimeout(t); res('throw: ' + e.message); }
  });
  r.moduleWorker = await tryWorker(() => new Worker('/assets/worker.js', { type: 'module' }));
  r.blobWorker = await tryWorker(() => new Worker(URL.createObjectURL(new Blob(['self.onmessage = (e) => self.postMessage(e.data * 2)'], { type: 'text/javascript' }))));
  r.cssLoaded = getComputedStyle(document.body).paddingTop === '24px';
  r.spaFallback = await fetch('/some/client/route').then((x) => x.status + ' ' + x.headers.get('content-type'));
  r.missingAsset = await fetch('/assets/missing.js').then((x) => x.status);
  r.traversal = await fetch('/..%2f..%2fpackage.json').then((x) => x.status);
  window.__dbstudioRestarted = new Promise((res) => b.onEngineRestarted(res));
  return r;
})()`;

const PHASE2 = `(async () => {
  const info = await window.__dbstudioRestarted;
  const health = await fetch(info.baseUrl + '/api/v1/health', { headers: { Authorization: 'Bearer ' + info.token } }).then((x) => x.json());
  return { restartedBaseUrl: info.baseUrl, healthAfterRestart: health };
})()`;

function report(result: unknown): void {
  process.stdout.write(`DBSTUDIO_SMOKE_RESULT ${JSON.stringify(result)}\n`);
}

export function runSmoke(win: BrowserWindow, supervisor: EngineSupervisor): void {
  const timeout = setTimeout(() => { report({ error: 'smoke timeout' }); app.quit(); }, 60_000);
  win.webContents.once('did-finish-load', async () => {
    try {
      const firstPid = supervisor.pid;
      const phase1 = await win.webContents.executeJavaScript(PHASE1, true);
      supervisor.simulateCrash();
      const phase2 = await win.webContents.executeJavaScript(PHASE2, true);
      report({ ...phase1, ...phase2, enginePids: [firstPid, supervisor.pid] });
    } catch (e) {
      const msg = String((e as Error)?.stack ?? e);
      // A failed engine start is reported (after the error page renders) by main.ts's start-failure path.
      if (msg.includes('get-engine-info')) return;
      report({ error: msg });
    } finally {
      clearTimeout(timeout);
    }
    app.quit(); // exercises the real before-quit cleanup
  });
}
