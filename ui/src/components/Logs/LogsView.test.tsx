// Logs sub-view against the MSW mock engine + fake WebSocket: sources, filters, paging, privilege state, tail
// buffer counters, MONITOR auto-stop, export and keyboard handling.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../api/client';
import type { LogEntry, LogQuery } from '../../api/types';
import { engineSocket } from '../../api/ws';
import { installKeyDispatcher } from '../../commands/dispatcher';
import { runCommand } from '../../commands/registry';
import { useUi } from '../../store/ui';
import { useTabs } from '../../store/tabs';
import { installLogsEngine, LogsHost, resetTabs, stubClipboard, stubPlatform, until } from './__tests__/kit';
import { registerLogsCommands } from './commands';
import { openLogs } from './open';

const env = installLogsEngine();
let clipboard: string[] = [];

beforeAll(() => {
  registerLogsCommands();
  installKeyDispatcher();
});
beforeEach(() => {
  resetTabs();
  clipboard = stubClipboard();
  useUi.setState({ toasts: [] } as never);
});
afterEach(() => env.server.resetHandlers());

function show(cid: string, opts?: Parameters<typeof openLogs>[1]) {
  const id = openLogs(cid, opts);
  render(<LogsHost tabId={id} />);
  return id;
}

const queries = (cid: string) => env.hits(`/logs/${cid}/query`);
async function lastQuery(cid: string): Promise<LogQuery> {
  await until(() => queries(cid).length > 0 && queries(cid).at(-1)!.body != null);
  return queries(cid).at(-1)!.body as LogQuery;
}
const statusLine = () => document.querySelector('.logs-status [role="status"]')?.textContent ?? '';
const patchState = (id: string, p: Record<string, unknown>) =>
  act(() => useTabs.getState().updateView(id, { state: { ...((useTabs.getState().tabs.find((t) => t.id === id) as { state?: object } | undefined)?.state), ...p } }));
async function openStreams() {
  return (await api.listStreams()).filter((s) => s.kind === 'logs.tail');
}

describe('sources', () => {
  it('the engine tab shows the engine log, queried under cid engine; Activity is disabled', async () => {
    show('engine');
    const q = await lastQuery('engine');
    expect(q).toMatchObject({ sourceId: 'engine', limit: 1000 });
    await waitFor(() => expect(statusLine()).toMatch(/\d+ entries/));
    expect(screen.getByRole('button', { name: /Activity/ })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Log source' })).toHaveTextContent('Engine log');
  });

  it('SQLite lists the engine log only', async () => {
    show('c_shop');
    await lastQuery('engine');
    expect(queries('c_shop')).toHaveLength(0);
    expect(env.hits('/logs/c_shop/sources', 'GET')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Log source' })).toHaveTextContent('Engine log');
  });

  it('SQL Server starts on the error log with the archive select and the default level filter', async () => {
    show('c_prod');
    const q = await lastQuery('c_prod');
    expect(q.sourceId).toBe('errorlog');
    expect(q.levels).toEqual(['info', 'warn', 'error', 'fatal', 'unknown']);
    expect(q.from).toBeTruthy();
    expect(q.archive).toBeUndefined();
    expect(screen.getByRole('combobox', { name: 'Log archive' })).toHaveTextContent('Current');
  });

  it('queries an archive file', async () => {
    const id = show('c_prod');
    await lastQuery('c_prod');
    patchState(id, { archive: 2 });
    await until(() => (queries('c_prod').at(-1)?.body as LogQuery | null)?.archive === 2);
  });

  it('Kafka offers the client log and the engine log', async () => {
    show('c_kafka');
    const q = await lastQuery('c_kafka');
    expect(q.sourceId).toBe('client');
  });

  it('notes a truncated source window (MongoDB getLog)', async () => {
    show('c_mongo', { sourceId: 'getLog' });
    expect(await screen.findByText(/capped window/)).toBeInTheDocument();
  });

  it('shows a source error inline and keeps the engine log', async () => {
    env.server.use(http.get('*/api/v1/logs/c_prod/sources', () => HttpResponse.json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'Cannot connect to prod: timeout' } }, { status: 503 })));
    show('c_prod');
    expect(await screen.findByText(/Could not list the log sources of Prod SQL/)).toBeInTheDocument();
    await lastQuery('engine');
  });
});

describe('privilege state', () => {
  it('shows the exact GRANT for an unavailable source and copies it', async () => {
    show('c_prod', { sourceId: 'system_health' });
    expect(await screen.findByTestId('grant-text')).toHaveTextContent('GRANT VIEW SERVER STATE TO [app];');
    expect(queries('c_prod')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Copy GRANT' }));
    await until(() => clipboard.length > 0);
    expect(clipboard[0]).toBe('GRANT VIEW SERVER STATE TO [app];');
  });

  it('renders a 403 PRIVILEGE answer with detail.needs', async () => {
    env.server.use(http.post('*/api/v1/logs/c_pg/query', () => HttpResponse.json({ error: { code: 'PRIVILEGE', message: 'permission denied for function pg_read_file', detail: { needs: 'GRANT pg_read_server_files TO app;' } } }, { status: 403 })));
    show('c_pg');
    expect(await screen.findByTestId('grant-text')).toHaveTextContent('GRANT pg_read_server_files TO app;');
    expect(screen.getByText('permission denied for function pg_read_file')).toBeInTheDocument();
  });

  it('shows an error with Retry', async () => {
    let fail = true;
    env.server.use(http.post('*/api/v1/logs/c_pg/query', () => (fail ? HttpResponse.json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'server closed the connection' } }, { status: 503 }) : undefined)));
    show('c_pg');
    expect(await screen.findByText('server closed the connection')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(statusLine()).toMatch(/entries/));
  });

  it('offers CONFIG SET for the Redis latency hint (not read-only)', async () => {
    let body: unknown = null;
    env.server.use(http.put('*/api/v1/redis/c_redis/config', async ({ request }) => {
      body = await request.json();
      return new HttpResponse(null, { status: 204 });
    }));
    show('c_redis', { sourceId: 'latency' });
    fireEvent.click(await screen.findByRole('button', { name: 'Run CONFIG SET latency-monitor-threshold 100' }));
    await until(() => body != null);
    expect(body).toEqual({ name: 'latency-monitor-threshold', value: '100' });
  });

  it('shows the profiler hint with Copy', async () => {
    show('c_mongo', { sourceId: 'profiler:shop' });
    expect(await screen.findByText(/Profiling is off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await until(() => clipboard.length > 0);
    expect(clipboard[0]).toBe('db.setProfilingLevel(1, { slowms: 100 })');
  });

  it('turns the Mongo profiler on from its hint, then probes the sources again', async () => {
    let body: unknown = null;
    env.server.use(http.put('*/api/v1/mongo/c_mongo/db/shop/profiling', async ({ request }) => {
      body = await request.json();
      return HttpResponse.json({ level: 1, slowms: 100, sampleRate: 1 });
    }));
    show('c_mongo', { sourceId: 'profiler:shop' });
    const turnOn = await screen.findByRole('button', { name: 'Turn on profiling' });
    const before = env.hits('/logs/c_mongo/sources', 'GET').length;
    fireEvent.click(turnOn);
    await until(() => body != null);
    expect(body).toEqual({ level: 1, slowms: 100 });
    await until(() => env.hits('/logs/c_mongo/sources', 'GET').length > before);
    expect(env.hits('/logs/c_mongo/sources', 'GET').at(-1)!.search).toContain('refresh=true');
  });
});

describe('filters and paging', () => {
  it('loads older entries with the seq cursor', async () => {
    const id = show('c_prod');
    await lastQuery('c_prod');
    patchState(id, { from: '7d' });
    await waitFor(() => expect(statusLine()).toBe('1,000 entries'));
    const firstSeq = (queries('c_prod').at(-1)!.body as LogQuery).before;
    expect(firstSeq).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: /Load older/ }));
    await waitFor(() => expect(statusLine()).toBe('1,500 entries'));
    const q = queries('c_prod').at(-1)!.body as LogQuery;
    expect(q.before).toBe(501);
    expect(screen.queryByRole('button', { name: /Load older/ })).toBeNull();
  });

  it('toggles a level chip (command) and re-queries', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    const debug = screen.getByRole('button', { name: /Debug/ });
    expect(debug).toHaveAttribute('aria-pressed', 'false');
    const n = queries('c_prod').length;
    fireEvent.click(debug);
    await until(() => queries('c_prod').length > n && queries('c_prod').at(-1)!.body != null);
    expect((queries('c_prod').at(-1)!.body as LogQuery).levels).toContain('debug');
    expect(screen.getByRole('button', { name: /Debug/ })).toHaveAttribute('aria-pressed', 'true');
    runCommand('logs.level.error');
    await until(() => !((queries('c_prod').at(-1)?.body as LogQuery | null)?.levels ?? ['error']).includes('error'));
  });

  it('debounces the search, sends plain text as q and highlights matches', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    const n = queries('c_prod').length;
    fireEvent.change(screen.getByRole('textbox', { name: 'Search log entries' }), { target: { value: 'login' } });
    expect(queries('c_prod')).toHaveLength(n);
    await until(() => (queries('c_prod').at(-1)?.body as LogQuery | null)?.q === 'login');
    await waitFor(() => expect(document.querySelectorAll('mark.log-hit').length).toBeGreaterThan(0));
    expect(document.querySelector('mark.log-hit')!.textContent!.toLowerCase()).toBe('login');
  });

  it('applies a regex client-side (not sent to the server)', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search log entries' }), { target: { value: 'Backup|Recovery' } });
    await waitFor(() => expect(statusLine()).toMatch(/of [\d,]+ entries · regex/));
    expect((queries('c_prod').at(-1)!.body as LogQuery).q).toBeUndefined();
  });

  it('switches To to a custom time', async () => {
    const id = show('c_prod');
    await lastQuery('c_prod');
    patchState(id, { to: '2026-10-18T10:00:00.000Z' });
    await until(() => (queries('c_prod').at(-1)?.body as LogQuery | null)?.to === '2026-10-18T10:00:00.000Z');
    expect(screen.getByLabelText('To date and time')).toHaveValue();
  });
});

describe('tail', () => {
  it('opens a logs.tail stream after the query (resuming after the newest seq) and appends entries', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    await waitFor(() => expect(statusLine()).toMatch(/entries/));
    fireEvent.click(screen.getByRole('button', { name: /Tail/ }));
    await until(() => env.hits('/streams').some((r) => r.body != null));
    const req = env.hits('/streams').at(-1)!.body as { kind: string; connectionId: string; params: Record<string, unknown> };
    expect(req).toMatchObject({ kind: 'logs.tail', connectionId: 'c_prod', params: { sourceId: 'errorlog' } });
    expect(typeof req.params.after).toBe('number');
    await waitFor(() => expect(statusLine()).toMatch(/tailing · 0 dropped · 0 evicted/));
    const before = Number(statusLine().replace(/,/g, '').match(/^(\d+)/)![1]);
    await waitFor(() => expect(Number(statusLine().replace(/,/g, '').match(/^(\d+)/)![1])).toBeGreaterThan(before), { timeout: 3000 });
  });

  it('counts engine drops (stream.state) and client evictions (cap 20,000)', async () => {
    show('engine');
    await lastQuery('engine');
    runCommand('logs.tail');
    await until(() => statusLine().includes('tailing'));
    const [s] = await openStreams();
    const items: LogEntry[] = Array.from({ length: 20_100 }, (_, i) => ({ ts: new Date().toISOString(), level: 'info', source: 't', message: `bulk ${i}`, seq: 5_000_000 + i }));
    act(() => {
      engineSocket.dispatch({ type: 'stream.data', ts: new Date().toISOString(), streamId: s.streamId, items, seq: 99 });
      engineSocket.dispatch({ type: 'stream.state', ts: new Date().toISOString(), streamId: s.streamId, state: 'open', reason: null, dropped: 1240 });
    });
    await waitFor(() => expect(statusLine()).toMatch(/^20,000 entries · tailing · 1,240 dropped · [\d,]+ evicted$/));
    expect(Number(statusLine().match(/([\d,]+) evicted/)![1].replace(/,/g, ''))).toBeGreaterThanOrEqual(100);
  });

  it('Space pauses and resumes the stream from the list', async () => {
    show('engine');
    await lastQuery('engine');
    runCommand('logs.tail');
    await until(() => statusLine().includes('tailing'));
    const list = screen.getByRole('listbox');
    list.focus();
    fireEvent.keyDown(list, { key: ' ', code: 'Space' });
    await until(() => env.hits('/pause').length === 1);
    expect(statusLine()).toMatch(/paused/);
    fireEvent.keyDown(list, { key: ' ', code: 'Space' });
    await until(() => env.hits('/resume').length === 1);
  });

  it('Redis MONITOR: warning banner, live-only tail, Extend after the auto-stop marker', async () => {
    const id = show('c_redis');
    await lastQuery('c_redis');
    act(() => runCommand('logs.tail'));
    patchState(id, { sourceId: 'monitor', tail: true });
    expect(await screen.findByText(/MONITOR costs ~50 % throughput on busy servers/)).toBeInTheDocument();
    await until(() => env.hits('/streams').some((r) => (r.body as { params?: { sourceId?: string } } | null)?.params?.sourceId === 'monitor'));
    await until(() => statusLine().includes('tailing'));
    const s = (await openStreams()).find((x) => x.connectionId === 'c_redis')!;
    act(() => {
      engineSocket.dispatch({ type: 'stream.data', ts: new Date().toISOString(), streamId: s.streamId, seq: 50, items: [{ ts: new Date().toISOString(), level: 'warn', source: 'monitor', message: 'MONITOR stopped after 10 minutes', fields: { autoStopped: 'true' }, seq: 9_999_999 }] });
      engineSocket.dispatch({ type: 'stream.state', ts: new Date().toISOString(), streamId: s.streamId, state: 'ended', reason: 'completed', dropped: 0 });
    });
    const extend = await screen.findByRole('button', { name: 'Extend 10 min' });
    const n = env.hits('/streams').length;
    fireEvent.click(extend);
    await until(() => env.hits('/streams').length > n && env.hits('/streams').at(-1)!.body != null);
    expect(env.hits('/streams').at(-1)!.body).toMatchObject({ kind: 'logs.tail', params: { sourceId: 'monitor', maxMinutes: 10 } });
    await until(() => statusLine().includes('tailing'));
    expect(screen.queryByRole('button', { name: 'Extend 10 min' })).toBeNull();
  });

  it('closes the stream when the tab unmounts', async () => {
    const id = openLogs('engine');
    const r = render(<LogsHost tabId={id} />);
    await lastQuery('engine');
    runCommand('logs.tail');
    await until(() => statusLine().includes('tailing'));
    const sid = (await openStreams()).at(-1)!.streamId;
    r.unmount();
    await until(() => env.requests.some((x) => x.method === 'DELETE' && x.path === `/streams/${sid}`));
  });
});

describe('keyboard', () => {
  it('arrows select, Enter expands, Esc collapses, Mod+C copies, Mod+L clears, Mod+F searches', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    await waitFor(() => expect(statusLine()).toMatch(/^[1-9][\d,]* entries$/));
    const list = screen.getByRole('listbox');
    list.focus();
    fireEvent.keyDown(list, { key: 'Home' });
    const sel = () => list.querySelector('[role="option"][aria-selected="true"]') as HTMLElement | null;
    expect(sel()).not.toBeNull();
    expect(list.getAttribute('aria-activedescendant')).toBe(sel()!.id);
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    const second = sel()!;
    fireEvent.keyDown(list, { key: 'Enter' });
    await waitFor(() => expect(sel()).toHaveAttribute('aria-expanded', 'true'));
    expect(sel()!.querySelector('.log-detail')).not.toBeNull();
    fireEvent.keyDown(list, { key: 'Escape' });
    await waitFor(() => expect(sel()).toHaveAttribute('aria-expanded', 'false'));
    expect(sel()!.id).toBe(second.id);

    fireEvent.keyDown(list, { key: 'c', ctrlKey: true });
    await until(() => clipboard.length > 0);
    expect(clipboard[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[.+\] /);

    fireEvent.keyDown(list, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search log entries' }));

    list.focus();
    fireEvent.keyDown(list, { key: 'l', ctrlKey: true });
    await waitFor(() => expect(statusLine()).toBe('0 entries'));
  });

  it('F5 refreshes', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    const n = queries('c_prod').length;
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'F5' });
    await until(() => queries('c_prod').length > n);
  });

  it('Esc in the list clears the search', async () => {
    const id = show('c_prod');
    await lastQuery('c_prod');
    patchState(id, { search: 'login' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search log entries' })).toHaveValue('login'));
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search log entries' })).toHaveValue(''));
  });
});

describe('export', () => {
  it('exports the tail buffer client-side (csv)', async () => {
    const plat = stubPlatform();
    try {
      show('engine');
      await lastQuery('engine');
      runCommand('logs.tail');
      await until(() => statusLine().includes('tailing'));
      runCommand('logs.export.csv');
      await until(() => plat.saved.length === 1);
      expect(plat.saved[0].suggestedName).toMatch(/^logs-engine-\d{8}-\d{6}\.csv$/);
      expect(String(plat.saved[0].content).split('\r\n')[0]).toBe('ts,level,source,message,detail,fields');
      expect(env.hits('/logs/engine/export')).toHaveLength(0);
    } finally {
      plat.restore();
    }
  });

  it('exports a range through the engine (browser: the file comes back)', async () => {
    const plat = stubPlatform();
    try {
      show('c_prod');
      await lastQuery('c_prod');
      runCommand('logs.export.json');
      await until(() => plat.saved.length === 1);
      const body = env.hits('/logs/c_prod/export').at(-1)!.body as Record<string, unknown>;
      expect(body).toMatchObject({ sourceId: 'errorlog', format: 'json', path: null, limit: 5000 });
      expect(plat.saved[0].suggestedName).toMatch(/^logs-errorlog-.*\.json$/);
      expect(plat.saved[0].content).toBeInstanceOf(Blob);
    } finally {
      plat.restore();
    }
  });

  it('exports a range to a file as an engine job (desktop)', async () => {
    const plat = stubPlatform(true);
    try {
      show('c_prod');
      await lastQuery('c_prod');
      runCommand('logs.export.txt');
      await until(() => useUi.getState().toasts.some((t) => /Exported [\d,]+ log entries/.test(t.text)));
      const body = env.hits('/logs/c_prod/export').at(-1)!.body as Record<string, unknown>;
      expect(String(body.path)).toMatch(/^C:\\exports\\logs-errorlog-/);
      expect(plat.saved).toHaveLength(0);
    } finally {
      plat.restore();
    }
  });

  it('the Export menu lists the three formats', async () => {
    show('c_prod');
    await lastQuery('c_prod');
    fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    const { useMenu } = await import('../common/Menu');
    expect(useMenu.getState().open?.items.map((i) => i.id)).toEqual(['logs.export.txt', 'logs.export.csv', 'logs.export.json']);
    act(() => useMenu.getState().hide());
  });
});

describe('expanded row', () => {
  it('shows message, detail, fields and copies', async () => {
    const id = show('c_prod');
    await lastQuery('c_prod');
    patchState(id, { search: 'filegroup' });
    await waitFor(() => expect(statusLine()).toMatch(/^[1-9][\d,]* of/));
    const row = screen.getAllByRole('option')[0];
    fireEvent.doubleClick(row);
    await waitFor(() => expect(row.querySelector('pre.log-detail-text.muted')?.textContent).toMatch(/'PRIMARY' filegroup is full/));
    expect(row.querySelector('pre.log-detail-text.muted mark')?.textContent).toBe('filegroup');
    expect(within(row).getByText('severity')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Copy/ }));
    await until(() => clipboard.length > 0);
    expect(clipboard[0]).toContain('    severity: 17');
  });
});
