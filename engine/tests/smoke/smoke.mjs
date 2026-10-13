// End-to-end smoke test against a running engine (Node 22+: global fetch and WebSocket).
//
//   dotnet run --project engine/src/DbStudio.Host -- --dev --port 5121 --token dev-token
//   node engine/tests/smoke/smoke.mjs [--url http://127.0.0.1:5121] [--token dev-token]
//
// or let engine/tests/smoke/run-smoke.ps1 start/stop the engine with a temp data dir.
// Exits 0 when every check passes, 1 otherwise.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('url', 'http://127.0.0.1:5121').replace(/\/$/, '');
const TOKEN = arg('token', 'dev-token');
const API = `${BASE}/api/v1`;

let failures = 0;
const ok = (cond, message, extra) => {
  if (cond) console.log(`  ok   ${message}`);
  else {
    failures++;
    console.log(`  FAIL ${message}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 400)}` : ''}`);
  }
};

async function call(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, headers: res.headers, json, text };
}

function openSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
    const events = [];
    const waiters = [];
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${e.message ?? e}`));
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data);
      events.push(ev);
      if (ev.type === 'auth.ok') resolve(api);
      for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(ev); }
    };
    const api = {
      ws, events,
      waitFor(pred, ms = 15000, label = 'event') {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise((res, rej) => {
          const w = { pred, resolve: res };
          waiters.push(w);
          setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`timeout waiting for ${label}`)); } }, ms);
        });
      },
    };
    setTimeout(() => reject(new Error('no auth.ok within 5 s')), 5000);
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'dbstudio-smoke-'));
  const dbPath = join(dir, 'smoke.sqlite');
  console.log(`engine ${BASE}, temp db ${dbPath}`);
  try {
    console.log('meta');
    const unauth = await fetch(`${API}/health`);
    ok(unauth.status === 401, 'request without token is rejected with 401');
    const health = await call('GET', '/health');
    ok(health.status === 200 && health.json.status === 'ok', 'GET /health', health.json);
    const providers = await call('GET', '/providers');
    ok(providers.status === 200 && providers.json.some((p) => p.id === 'sqlite' && p.dialect === 'sqlite'), 'GET /providers lists sqlite');
    const settings = await call('GET', '/settings');
    ok(settings.status === 200 && settings.json.results.maxRows > 0, 'GET /settings');

    console.log('websocket');
    const sock = await openSocket();
    ok(true, 'WS auth.ok received');
    sock.ws.send(JSON.stringify({ type: 'ping' }));
    await sock.waitFor((e) => e.type === 'pong', 5000, 'pong');
    ok(true, 'WS ping → pong');

    console.log('connection + session');
    const conn = await call('POST', '/connections', {
      name: 'Smoke SQLite', providerId: 'sqlite', color: null, folder: 'Smoke', readOnly: false,
      props: { path: dbPath, createIfMissing: true }, savePassword: true, password: null,
    });
    ok(conn.status === 200 && conn.json.id?.startsWith('c_'), 'POST /connections', conn.json);
    const cid = conn.json.id;
    const test = await call('POST', '/connections/test', { profile: conn.json, password: null, useStoredPassword: true });
    ok(test.status === 200 && test.json.ok === true && test.json.serverInfo.version.startsWith('SQLite'), 'POST /connections/test', test.json);

    // Load the catalog before the DDL so the engine has something to invalidate.
    const cat0 = await call('GET', `/connections/${cid}/catalog`);
    ok(cat0.status === 200 && cat0.json.dialect === 'sqlite' && cat0.json.defaultSchema === 'main', 'GET catalog (empty db)', cat0.json);

    const sess = await call('POST', '/sessions', { connectionId: cid, database: null, txMode: 'auto', captureServerOutput: true });
    ok(sess.status === 200 && sess.json.state === 'idle' && sess.json.dialect === 'sqlite', 'POST /sessions', sess.json);
    const sid = sess.json.sessionId;

    console.log('execute');
    const exec = await call('POST', `/sessions/${sid}/execute`, {
      batches: [
        { sql: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price DECIMAL(10,2), data BLOB)', line: 1, col: 1 },
        { sql: "INSERT INTO items (name, price, data) VALUES ('a', 1.5, x'00ff'), ('b', 2.25, NULL), ('c', NULL, NULL)", line: 2, col: 1 },
        { sql: 'SELECT id, name, price, data FROM items ORDER BY id', line: 3, col: 1 },
        { sql: "UPDATE items SET name = upper(name) WHERE id <= 2", line: 4, col: 1 },
      ],
      maxRows: 10000, stopOnError: true, label: 'script', source: { tabId: 't1', title: 'smoke.sql' },
    });
    ok(exec.status === 202 && exec.json.executionId?.startsWith('x_'), 'POST execute → 202', exec.json);
    const xid = exec.json.executionId;
    const done = await sock.waitFor((e) => e.type === 'exec.done' && e.executionId === xid, 15000, 'exec.done');
    const mine = sock.events.filter((e) => e.executionId === xid);
    ok(mine[0]?.type === 'exec.started' && mine[0].batchCount === 4, 'exec.started first');
    const rs = mine.find((e) => e.type === 'exec.resultset');
    ok(rs && rs.batchIndex === 2 && rs.columns.map((c) => c.name).join() === 'id,name,price,data', 'exec.resultset with columns', rs);
    ok(rs?.columns[0].kind === 'int' && rs?.columns[2].kind === 'decimal' && rs?.columns[3].kind === 'binary', 'column kinds int/decimal/binary', rs?.columns);
    const rows = mine.filter((e) => e.type === 'exec.rows').flatMap((e) => e.rows);
    ok(rows.length === 3 && rows[0][1] === 'a' && rows[0][3]?.$bin === 'AP8=' && rows[0][3]?.len === 2 && rows[2][2] === null, 'exec.rows values', rows);
    const end = mine.find((e) => e.type === 'exec.resultset.end');
    ok(end?.rowCount === 3 && end.truncated === false, 'exec.resultset.end', end);
    const affected = mine.filter((e) => e.type === 'exec.affected');
    ok(affected.some((a) => a.batchIndex === 1 && a.count === 3 && a.statementKind === 'INSERT'), 'exec.affected INSERT 3', affected);
    ok(affected.some((a) => a.batchIndex === 3 && a.count === 2 && a.statementKind === 'UPDATE'), 'exec.affected UPDATE 2', affected);
    ok(mine.filter((e) => e.type === 'exec.batch.ended').length === 4, '4 × exec.batch.ended');
    ok(done.status === 'ok' && done.resultSets === 1 && done.rowsAffected === 5 && done.sessionId === sid && done.txOpen === false, 'exec.done summary', done);
    await sock.waitFor((e) => e.type === 'session.changed' && e.sessionId === sid && e.state === 'idle', 5000, 'session.changed idle');
    ok(true, 'session.changed back to idle');

    const changed = await sock.waitFor((e) => e.type === 'catalog.changed' && e.connectionId === cid, 10000, 'catalog.changed');
    ok(changed.schemas.includes('main') && changed.version > cat0.json.version, 'catalog.changed after CREATE TABLE', changed);

    console.log('result store');
    const page = await call('GET', `/executions/${xid}/resultsets/0/rows?offset=1&limit=10`);
    ok(page.status === 200 && page.json.total === 3 && page.json.rows.length === 2 && page.json.rows[0][1] === 'b', 'GET rows replay', page.json);
    const cell = await call('GET', `/executions/${xid}/resultsets/0/cell?row=0&col=3`);
    ok(cell.status === 200 && cell.json.kind === 'binary' && cell.json.value === 'AP8=' && cell.json.len === 2, 'GET cell (binary)', cell.json);
    const csv = await call('POST', `/executions/${xid}/resultsets/0/export`, { format: 'csv', path: null, options: { header: true } });
    ok(csv.status === 200 && csv.text.startsWith('id,name,price,data\r\n1,a,1.5,0x00FF\r\n') && /attachment/.test(csv.headers.get('content-disposition') ?? ''), 'export CSV attachment', csv.text);

    console.log('catalog');
    const cat1 = await call('GET', `/connections/${cid}/catalog?schemas=main`);
    const etag = cat1.headers.get('etag');
    const items = cat1.json?.schemas?.[0]?.objects?.find((o) => o.n === 'items');
    ok(cat1.status === 200 && !!etag && items?.t === 'table', 'GET catalog has items', cat1.json);
    ok(JSON.stringify(items?.c?.[0]) === JSON.stringify(['id', 'INTEGER', 0, 1, 1, null]) && items?.pk?.[0] === 'id', 'compact column tuple + pk', items);
    const cat304 = await call('GET', `/connections/${cid}/catalog?schemas=main`, undefined, { 'If-None-Match': etag });
    ok(cat304.status === 304, 'GET catalog with If-None-Match → 304', cat304.status);
    const stale = await call('GET', `/connections/${cid}/catalog`, undefined, { 'If-None-Match': cat0.headers.get('etag') });
    ok(stale.status === 200, 'stale ETag → 200');
    const schemas = await call('GET', `/connections/${cid}/catalog/schemas`);
    ok(schemas.status === 200 && schemas.json.schemas.some((s) => s.name === 'main' && s.loaded), 'GET catalog/schemas', schemas.json);
    const details = await call('GET', `/connections/${cid}/catalog/object?schema=main&name=items&type=table`);
    ok(details.status === 200 && details.json.columns.length === 4 && details.json.columns[0].isPk, 'GET catalog/object', details.json);
    const ddl = await call('GET', `/connections/${cid}/catalog/ddl?schema=main&name=items&type=table`);
    ok(ddl.status === 200 && ddl.json.source === 'stored' && ddl.json.ddl.includes('CREATE TABLE items'), 'GET catalog/ddl', ddl.json);
    const missing = await call('GET', `/connections/${cid}/catalog/object?schema=main&name=nope&type=table`);
    ok(missing.status === 404 && missing.json.error.code === 'NOT_FOUND', 'unknown object → 404 envelope', missing.json);

    console.log('errors, busy, cancel');
    const bad = await call('POST', `/sessions/${sid}/execute`, { batches: [{ sql: 'SELECT * FROM nope', line: 7, col: 1 }], maxRows: 100, stopOnError: true, label: 'statement' });
    const badDone = await sock.waitFor((e) => e.type === 'exec.done' && e.executionId === bad.json.executionId, 10000, 'exec.done (error)');
    const err = sock.events.find((e) => e.type === 'exec.error' && e.executionId === bad.json.executionId);
    ok(badDone.status === 'error' && err?.line === 7 && /no such table/.test(err.message), 'exec.error with document line', err);

    const long = await call('POST', `/sessions/${sid}/execute`, {
      batches: [{ sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000000) SELECT count(*) FROM c', line: 1, col: 1 }],
      maxRows: 10, stopOnError: true, label: 'statement',
    });
    const busy = await call('POST', `/sessions/${sid}/execute`, { batches: [{ sql: 'SELECT 1', line: 1, col: 1 }], maxRows: 10, stopOnError: true, label: 'statement' });
    ok(busy.status === 409 && busy.json.error.code === 'SESSION_BUSY', 'second execute → 409 SESSION_BUSY', busy.json);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    const cancel = await call('POST', `/sessions/${sid}/cancel`);
    ok(cancel.status === 200 && cancel.json.cancelled === true, 'POST cancel');
    const cancelled = await sock.waitFor((e) => e.type === 'exec.done' && e.executionId === long.json.executionId, 10000, 'exec.done (cancelled)');
    ok(cancelled.status === 'cancelled' && Date.now() - t0 < 3000, `cancelled in ${Date.now() - t0} ms`, cancelled);

    console.log('transactions');
    const manual = await call('POST', `/sessions/${sid}/tx-mode`, { txMode: 'manual' });
    ok(manual.status === 200 && manual.json.txMode === 'manual', 'tx-mode manual');
    const ins = await call('POST', `/sessions/${sid}/execute`, { batches: [{ sql: "INSERT INTO items (name) VALUES ('tx')", line: 1, col: 1 }], maxRows: 10, stopOnError: true, label: 'statement' });
    const insDone = await sock.waitFor((e) => e.type === 'exec.done' && e.executionId === ins.json.executionId, 10000, 'exec.done (tx)');
    ok(insDone.txOpen === true, 'exec.done txOpen=true in manual mode', insDone);
    const toAuto = await call('POST', `/sessions/${sid}/tx-mode`, { txMode: 'auto' });
    ok(toAuto.status === 409 && toAuto.json.error.code === 'TX_OPEN', 'switch to auto with open tx → 409 TX_OPEN');
    const del = await call('DELETE', `/sessions/${sid}`);
    ok(del.status === 409 && del.json.error.code === 'TX_OPEN', 'close with open tx → 409 TX_OPEN');
    const rb = await call('POST', `/sessions/${sid}/rollback`);
    ok(rb.status === 200 && rb.json.txOpen === false, 'rollback');

    console.log('history, diagnostics, read-only');
    const hist = await call('GET', `/history?connectionId=${cid}&q=upper`);
    ok(hist.status === 200 && hist.json.length >= 1 && hist.json[0].sql.includes('UPDATE items'), 'history full-text search', hist.json);
    const pin = await call('PUT', `/history/${hist.json[0]?.id}`, { pinned: true });
    ok(pin.status === 204, 'pin history entry');
    const diag = await call('POST', '/sql/diagnostics', { dialect: 'sqlite', sql: 'SELECT 1;\nSELEC * FROM items;\nSELECT * FROM missing_table', connectionId: cid });
    ok(diag.status === 200 && diag.json.engine === 'sqlite-prepare' && diag.json.diagnostics.length === 2 && diag.json.diagnostics[0].line === 2, 'POST /sql/diagnostics', diag.json);
    const oracleDiag = await call('POST', '/sql/diagnostics', { dialect: 'plsql', sql: 'SELECT 1 FROM dual', connectionId: null });
    ok(oracleDiag.status === 400 && oracleDiag.json.error.code === 'NOT_SUPPORTED', 'plsql diagnostics → NOT_SUPPORTED', oracleDiag.json);

    const ro = await call('POST', '/connections', { name: 'Smoke RO', providerId: 'sqlite', readOnly: true, props: { path: dbPath }, savePassword: true, password: null });
    const roSess = await call('POST', '/sessions', { connectionId: ro.json.id, database: null, txMode: 'auto', captureServerOutput: false });
    const roDel = await call('POST', `/sessions/${roSess.json.sessionId}/execute`, { batches: [{ sql: 'DELETE FROM items', line: 1, col: 1 }], maxRows: 10, stopOnError: true, label: 'statement' });
    ok(roDel.status === 403 && roDel.json.error.code === 'READ_ONLY', 'read-only connection rejects DELETE', roDel.json);
    const roSel = await call('POST', `/sessions/${roSess.json.sessionId}/execute`, { batches: [{ sql: 'SELECT count(*) FROM items', line: 1, col: 1 }], maxRows: 10, stopOnError: true, label: 'statement' });
    ok(roSel.status === 202, 'read-only connection allows SELECT');
    await sock.waitFor((e) => e.type === 'exec.done' && e.executionId === roSel.json.executionId, 10000, 'exec.done (ro)');

    console.log('cleanup');
    ok((await call('DELETE', `/sessions/${sid}?force=true`)).status === 204, 'DELETE session');
    ok((await call('DELETE', `/connections/${ro.json.id}`)).status === 204, 'DELETE read-only connection (closes its session)');
    ok((await call('DELETE', `/connections/${cid}`)).status === 204, 'DELETE connection');
    ok((await call('GET', `/sessions/${sid}`)).status === 404, 'session gone');
    sock.ws.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* file may still be closing */ }
  }
}

main()
  .catch((e) => { failures++; console.error(`  FAIL ${e.stack ?? e}`); })
  .finally(() => {
    console.log(failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures} failure(s))`);
    process.exit(failures === 0 ? 0 : 1);
  });
