// M1.5 HTTP/WebSocket smoke test of the WP-F endpoints against a running engine (Node 22+).
//
//   node engine/tests/smoke/M15/smoke-m15.mjs [--url http://127.0.0.1:5121] [--token dev-token]
//
// or let engine/tests/smoke/M15/run-smoke-m15.ps1 start/stop the engine with a temp data dir.
// Covers: POST /sample-db, execute with params, /describe, /explain (estimated + actual, exec.plan),
// designer types/table/script/apply (native + rebuild) and DDL_FAILED, view script, /filters CRUD,
// /history filters, SESSION_LIMIT, settings M1.5 keys, input validation (400 VALIDATION) and dev CORS.
// Exits 0 when every check passes, 1 otherwise.

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
    console.log(`  FAIL ${message}${extra !== undefined ? ` -> ${JSON.stringify(extra).slice(0, 600)}` : ''}`);
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
  return { status: res.status, headers: res.headers, json };
}

const events = [];
const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
ws.onmessage = (m) => events.push(JSON.parse(m.data));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = events.find(pred);
    if (hit) return hit;
    await sleep(50);
  }
  return null;
}
const of = (xid) => events.filter((e) => e.executionId === xid);
async function run(sid, sql, params, extra = {}) {
  const r = await call('POST', `/sessions/${sid}/execute`, { batches: [{ sql, line: 1, col: 1 }], maxRows: 1000, stopOnError: true, label: 'statement', params, ...extra });
  if (r.status !== 202) return { r, done: null, rows: [] };
  const done = await waitFor((e) => e.type === 'exec.done' && e.executionId === r.json.executionId);
  return { r, done, rows: of(r.json.executionId).filter((e) => e.type === 'exec.rows').flatMap((e) => e.rows), events: of(r.json.executionId) };
}

console.log('CORS (dev)');
{
  const res = await fetch(`${API}/health`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5199', 'Access-Control-Request-Method': 'GET' } });
  ok(res.headers.get('access-control-allow-origin') === 'http://localhost:5199', 'any localhost port is allowed with --dev');
  const bad = await fetch(`${API}/health`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' } });
  ok(!bad.headers.get('access-control-allow-origin'), 'other origins are not');
}

console.log('POST /sample-db');
const sample = await call('POST', '/sample-db', {});
ok(sample.status === 200 && sample.json.created && sample.json.path.endsWith('shop.sqlite'), 'creates the sample database', sample.json);
const again = await call('POST', '/sample-db', {});
ok(again.json.connectionId === sample.json.connectionId && !again.json.created, 'is idempotent');
const cid = sample.json.connectionId;
const sid = (await call('POST', '/sessions', { connectionId: cid, database: null, txMode: 'auto', captureServerOutput: false })).json.sessionId;

console.log('execute with params');
{
  const { done, rows } = await run(sid, 'SELECT count(*) FROM Customers WHERE CountryId = :c AND Id <= ?', [{ name: 'c', kind: 'int', value: 1 }, { name: '1', kind: 'int', value: 300 }]);
  ok(done?.status === 'ok' && rows.length === 1 && rows[0][0] > 0, 'named + positional binds', rows);
  const bad = await call('POST', `/sessions/${sid}/execute`, { batches: [{ sql: 'SELECT :x', line: 1, col: 1 }], maxRows: 10, stopOnError: true, label: 'statement', params: [{ name: 'x', kind: 'int', value: 'abc' }] });
  ok(bad.status === 400 && bad.json.error.code === 'VALIDATION', 'invalid param value → 400 VALIDATION', bad.json);
  const label = await run(sid, 'SELECT 1', null, { label: 'filter' });
  ok(label.done?.status === 'ok', 'label "filter" accepted');
}

console.log('describe');
{
  const d = await call('POST', `/sessions/${sid}/describe`, { sql: 'SELECT Id, Sku, Price FROM Products WHERE Price > :p', params: [{ name: 'p', kind: 'decimal', value: '10' }] });
  ok(d.status === 200 && d.json.editable && d.json.keyColumns[0] === 'Id' && d.json.columns.length === 3, 'columns, editable, key', d.json);
  const v = await call('POST', `/sessions/${sid}/describe`, { sql: 'UPDATE Products SET Price = 1' });
  ok(v.status === 400 && v.json.error.code === 'VALIDATION', 'non-SELECT → 400');
}

console.log('explain');
for (const mode of ['estimated', 'actual']) {
  const r = await call('POST', `/sessions/${sid}/explain`, { sql: 'SELECT o.Id FROM Orders o JOIN Customers c ON c.Id = o.CustomerId WHERE c.Id = :id', mode, params: [{ name: 'id', kind: 'int', value: 5 }] });
  ok(r.status === 202, `${mode}: 202`);
  const plan = await waitFor((e) => e.type === 'exec.plan' && e.executionId === r.json.executionId);
  const done = await waitFor((e) => e.type === 'exec.done' && e.executionId === r.json.executionId);
  ok(plan && plan.root && plan.mode === mode && plan.dialect === 'sqlite', `${mode}: exec.plan with a tree`, plan);
  ok(done?.status === 'ok' && (mode === 'actual' ? done.resultSets === 1 : done.resultSets === 0), `${mode}: exec.done`, done);
}
{
  const bad = await call('POST', `/sessions/${sid}/explain`, { sql: 'SELECT 1', mode: 'sideways' });
  ok(bad.status === 400, 'invalid mode → 400');
}

console.log('designer');
{
  const types = await call('GET', `/connections/${cid}/designer/types`);
  ok(types.status === 200 && types.json.types.some((t) => t.name === 'INTEGER') && types.json.features.transactionalDdl, 'types + features');
  const orders = (await call('GET', `/connections/${cid}/designer/table?name=Orders`)).json;
  ok(orders?.primaryKey?.columns?.[0] === 'Id' && orders.indexes.length === 2, 'GET table', orders);
  const missing = await call('GET', `/connections/${cid}/designer/table?name=NoSuchTable`);
  ok(missing.status === 404, 'unknown table → 404');
  const desired = { ...orders, columns: [...orders.columns, { id: 'n1', name: 'Channel', type: 'TEXT', nullable: true, default: "'web'", defaultName: null, identity: null, computed: null, collation: null, comment: null, autoincrement: false }] };
  const script = await call('POST', `/connections/${cid}/designer/table/script`, { database: null, original: orders, desired });
  ok(script.status === 200 && !script.json.rebuildRequired && script.json.statements.length === 1 && script.json.changes[0].kind === 'columnAdded', 'native ADD COLUMN script', script.json);
  const apply = await call('POST', `/connections/${cid}/designer/apply`, { database: null, statements: script.json.statements.map((s) => s.sql), transactional: true });
  ok(apply.status === 200 && apply.json.ok && apply.json.executed === 1, 'apply', apply.json);
  const after = (await call('GET', `/connections/${cid}/designer/table?name=Orders`)).json;
  const retyped = { ...after, columns: after.columns.map((c) => (c.name === 'Note' ? { ...c, type: 'VARCHAR(400)' } : c)) };
  const rebuild = await call('POST', `/connections/${cid}/designer/table/script`, { database: null, original: after, desired: retyped });
  ok(rebuild.json.rebuildRequired && rebuild.json.statements[0].kind === 'pragma', 'type change → rebuild script', rebuild.json);
  const applied = await call('POST', `/connections/${cid}/designer/apply`, { database: null, statements: rebuild.json.statements.map((s) => s.sql), transactional: true });
  ok(applied.status === 200, 'rebuild applies', applied.json);
  const { rows } = await run(sid, "SELECT (SELECT count(*) FROM Orders), (SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view'))");
  ok(rows[0]?.[0] === 1500 && rows[0]?.[1] === 3, 'data, triggers and view preserved', rows);
  const failed = await call('POST', `/connections/${cid}/designer/apply`, { database: null, statements: ['CREATE TABLE Tmp1 (a)', 'CREATE TABLE Tmp1 (a)'], transactional: true });
  ok(failed.status === 409 && failed.json.error.code === 'DDL_FAILED' && failed.json.error.detail.failedIndex === 1 && failed.json.error.detail.rolledBack, 'DDL_FAILED with failedIndex', failed.json);
  const invalid = await call('POST', `/connections/${cid}/designer/table/script`, { database: null, original: null, desired: { name: 'X', columns: [] } });
  ok(invalid.status === 400 && invalid.json.error.code === 'VALIDATION', 'invalid model → 400', invalid.json);
  const noStatements = await call('POST', `/connections/${cid}/designer/apply`, { database: null, statements: [], transactional: true });
  ok(noStatements.status === 400, 'empty apply → 400');
  const view = await call('GET', `/connections/${cid}/designer/view?name=CustomerOrderTotals`);
  ok(view.status === 200 && view.json.body.startsWith('SELECT'), 'GET view');
  const vs = await call('POST', `/connections/${cid}/designer/view/script`, { database: null, schema: null, name: 'CustomerOrderTotals', originalName: 'CustomerOrderTotals', body: view.json.body, options: { schemaBinding: false, checkOption: false, force: false } });
  ok(vs.status === 200 && vs.json.statements.length === 2, 'view script', vs.json);
}

console.log('filters');
{
  const model = { root: { id: 'g', logic: 'and', items: [{ id: 'c', column: 'Email', op: 'contains', values: ['@'] }] } };
  const f = await call('POST', '/filters', { connectionId: cid, signature: 'Email:string|Id:int', name: 'Has email', model });
  ok(f.status === 201 && f.json.id.startsWith('f_'), 'create', f.json);
  const list = await call('GET', `/filters?connectionId=${cid}&signature=${encodeURIComponent('Email:string|Id:int')}`);
  ok(list.json.length === 1 && list.json[0].model.root.items.length === 1, 'list by signature');
  const other = await call('GET', `/filters?connectionId=${cid}&signature=Other:int`);
  ok(other.json.length === 0, 'other signature → none');
  const put = await call('PUT', `/filters/${f.json.id}`, { lastUsedAt: new Date().toISOString() });
  ok(put.status === 200 && put.json.lastUsedAt, 'update lastUsedAt');
  const bad = await call('POST', '/filters', { connectionId: cid, signature: '', name: 'x', model: { root: {} } });
  ok(bad.status === 400, 'invalid model → 400');
  ok((await call('DELETE', `/filters/${f.json.id}`)).status === 204, 'delete');
  ok((await call('DELETE', `/filters/${f.json.id}`)).status === 404, 'delete again → 404');
}

console.log('history filters');
{
  await run(sid, 'SELECT * FROM no_such_table');
  const errors = await call('GET', `/history?connectionId=${cid}&status=error`);
  ok(errors.json.length >= 1 && errors.json.every((h) => h.status === 'error'), 'status=error', errors.json);
  const explains = await call('GET', `/history?connectionId=${cid}&status=ok&from=2000-01-01T00:00:00Z`);
  ok(explains.json.some((h) => h.label === 'explain') && explains.json.some((h) => h.label === 'filter'), 'labels explain / filter recorded');
  const pinned = await call('GET', `/history?connectionId=${cid}&pinned=true`);
  ok(pinned.json.length === 0, 'pinned=true');
  const bad = await call('GET', `/history?status=weird`);
  ok(bad.status === 400, 'bad status → 400');
}

console.log('settings and session limit');
{
  const s = await call('PUT', '/settings', { connections: { maxSessionsPerProfile: 2 }, format: { indent: 2 } });
  ok(s.status === 200 && s.json.connections.maxSessionsPerProfile === 2 && s.json.format.lineWidth === 120, 'M1.5 settings merge', s.json);
  await call('POST', '/sessions', { connectionId: cid, database: null, txMode: 'auto', captureServerOutput: false });
  const third = await call('POST', '/sessions', { connectionId: cid, database: null, txMode: 'auto', captureServerOutput: false });
  ok(third.status === 429 && third.json.error.code === 'SESSION_LIMIT' && third.json.error.detail.limit === 2, '429 SESSION_LIMIT', third.json);
  await call('PUT', '/settings', { connections: { maxSessionsPerProfile: null } });
  const info = (await call('GET', `/sessions/${sid}`)).json;
  ok('executingSince' in info && 'tabId' in info, 'SessionInfo M1.5 fields');
}

ws.close();
console.log(failures === 0 ? '\nAll M1.5 checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
