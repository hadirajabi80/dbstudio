// Workbench, CLI, Pub/Sub, Slowlog, Info (with MONITOR) and Analysis against the MSW Redis mock and the fake socket.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../../../api/client';
import { installKeyDispatcher } from '../../../commands/dispatcher';
import { registerRedisCommands } from '../commands';
import { openRedisView, type RedisView } from '../open';
import { clearHistoryForTests, loadHistory, rememberKeys } from '../store';
import { installRedisEngine, RedisHost, resetTabs } from './kit';

const env = installRedisEngine();

beforeAll(() => {
  registerRedisCommands();
  installKeyDispatcher();
});
beforeEach(() => {
  env.reset();
  resetTabs();
  clearHistoryForTests();
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

function show(view: RedisView, state: Record<string, unknown> = {}) {
  const id = openRedisView('c_redis', view, { db: 0, ...state });
  render(<RedisHost tabId={id} />);
  return id;
}

describe('workbench', () => {
  it('runs every line with F5 and shows one card per command', async () => {
    show('redis.workbench', { text: 'PING\n# comment\nSET wb "x y"\nGET wb\nHGETALL user:1001:profile' });
    const ed = await screen.findByRole('textbox', { name: 'Redis commands' });
    fireEvent.keyDown(ed, { key: 'F5' });
    await waitFor(() => expect(document.querySelectorAll('.redis-card')).toHaveLength(4));
    expect((env.hits('/commands', 'POST')[0].body as { raw: string[] }).raw).toEqual(['PING', 'SET wb "x y"', 'GET wb', 'HGETALL user:1001:profile']);
    const cards = [...document.querySelectorAll('.redis-card')];
    expect(cards[0].textContent).toContain('PONG');
    expect(cards[2].textContent).toContain('"x y"');
    // hash-like replies open as a field/value table
    expect(within(cards[3] as HTMLElement).getByRole('table')).toBeInTheDocument();
    expect(within(cards[3] as HTMLElement).getByRole('button', { name: 'Text' })).toBeInTheDocument();
  });

  it('Ctrl+Enter runs only the current line; SELECT moves the database', async () => {
    show('redis.workbench', { text: 'SELECT 1\nDBSIZE' });
    const ed = (await screen.findByRole('textbox', { name: 'Redis commands' })) as HTMLTextAreaElement;
    ed.setSelectionRange(2, 2);
    fireEvent.keyDown(ed, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(document.querySelectorAll('.redis-card')).toHaveLength(1));
    expect((env.hits('/commands', 'POST')[0].body as { raw: string[] }).raw).toEqual(['SELECT 1']);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Database' })).toHaveTextContent('db1'));
    fireEvent.keyDown(ed, { key: 'F5' });
    await waitFor(() => expect(env.hits('/commands', 'POST')).toHaveLength(2));
    expect((env.hits('/commands', 'POST')[1].body as { db: number }).db).toBe(1);
  });

  it('blocked commands show the hint as an error card; JSON replies pretty-print', async () => {
    show('redis.workbench', { text: 'MONITOR' });
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Redis commands' }), { key: 'F5' });
    await waitFor(() => expect(document.querySelector('.redis-card.error')).not.toBeNull());
    const card = document.querySelector('.redis-card.error')!;
    expect(card.textContent).toMatch(/Info › Monitor/);
  });

  it('pretty-prints JSON bulk replies and records history', async () => {
    show('redis.workbench', { text: 'GET config:feature-flags' });
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Redis commands' }), { key: 'F5' });
    await waitFor(() => expect(document.querySelector('.redis-card-body')?.textContent).toContain('\n  "darkMode": true'));
    expect(loadHistory('c_redis')).toContain('GET config:feature-flags');
  });
});

describe('cli', () => {
  async function type(line: string) {
    const input = screen.getByRole('textbox', { name: 'Redis command' });
    fireEvent.change(input, { target: { value: line } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input).not.toBeDisabled());
  }

  it('runs redis-cli quoting and renders replies like redis-cli', async () => {
    show('redis.cli');
    await screen.findByRole('textbox', { name: 'Redis command' });
    await type('SET k "a b"');
    await type('GET k');
    await type('RPUSH l x y');
    await type('LRANGE l 0 -1');
    const log = screen.getByRole('log', { name: 'CLI output' });
    await waitFor(() => expect(log.textContent).toContain('1) "x"\n2) "y"'));
    expect(log.textContent).toContain('> GET k"a b"');
    expect(log.textContent).toContain('(integer) 2');
  });

  it('reports quoting errors locally, help and clear', async () => {
    show('redis.cli');
    await screen.findByRole('textbox', { name: 'Redis command' });
    await type('SET k "oops');
    expect(screen.getByRole('log').textContent).toMatch(/unbalanced double quotes/);
    await type('help zadd');
    expect(screen.getByRole('log').textContent).toContain('ZADD key');
    await type('clear');
    expect(document.querySelectorAll('.redis-cli-line')).toHaveLength(0);
  });

  it('Up/Down walk the history; the prompt shows the selected db', async () => {
    show('redis.cli');
    const input = (await screen.findByRole('textbox', { name: 'Redis command' })) as HTMLInputElement;
    await type('PING');
    await type('SELECT 2');
    await waitFor(() => expect(document.querySelector('.redis-cli-prompt')?.textContent).toContain('[2]>'));
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('SELECT 2');
    fireEvent.keyDown(input, { key: 'ArrowUp', ctrlKey: true });
    expect(input.value).toBe('PING');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('SELECT 2');
  });

  it('Tab opens completion of commands and cached keys', async () => {
    rememberKeys('c_redis', 0, [{ key: 'user:1001:profile', type: 'hash', ttl: -1 }]);
    show('redis.cli');
    const input = (await screen.findByRole('textbox', { name: 'Redis command' })) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'HGETA' } });
    input.setSelectionRange(5, 5);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('listbox', { name: 'Suggestions' })).toHaveTextContent('HGETALL');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('HGETALL ');
    input.setSelectionRange(8, 8);
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.getByRole('option')).toHaveTextContent('user:1001:profile');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('HGETALL user:1001:profile');
  });
});

describe('pub/sub', () => {
  it('subscribes, receives published and pattern messages, pauses, and unsubscribes', async () => {
    show('redis.pubsub');
    const add = await screen.findByRole('textbox', { name: 'Channel or pattern' });
    fireEvent.change(add, { target: { value: 'news' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.change(add, { target: { value: 'orders.*' } });
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Subscribe/ }));
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());
    const streams = await api.listStreams();
    expect(streams.find((s) => s.kind === 'redis.subscribe')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Publish channel' }), { target: { value: 'news' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '{"headline":"hi"}' } });
    fireEvent.click(screen.getByRole('button', { name: /Publish/ }));
    await waitFor(() => expect(screen.getByRole('log', { name: 'Messages' }).textContent).toContain('{"headline":"hi"}'), { timeout: 3000 });
    await waitFor(() => expect(screen.getByRole('log', { name: 'Messages' }).textContent).toContain('orders.'), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: /^Pause$/ }));
    await waitFor(() => expect(screen.getByText('Paused')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Unsubscribe/ }));
    await waitFor(() => expect(screen.getByText('Stopped')).toBeInTheDocument());
    expect((await api.listStreams()).filter((s) => s.kind === 'redis.subscribe')).toHaveLength(0);
  });

  it('expands a message to pretty JSON and filters', async () => {
    show('redis.pubsub', { channels: ['news'], patterns: [] });
    fireEvent.click(await screen.findByRole('button', { name: /Subscribe/ }));
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument());
    await act(async () => {
      await api.redis.publish('c_redis', { channel: 'news', message: '{"a":1}' });
      await api.redis.publish('c_redis', { channel: 'news', message: 'plain' });
    });
    await waitFor(() => expect(document.querySelectorAll('.redis-msg')).toHaveLength(2));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter messages' }), { target: { value: 'plain' } });
    expect(document.querySelectorAll('.redis-msg')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter messages' }), { target: { value: '' } });
    fireEvent.click(document.querySelectorAll<HTMLElement>('.redis-msg-row')[1]);
    expect(document.querySelector('.redis-msg-detail')?.textContent).toBe('{\n  "a": 1\n}');
  });
});

describe('slowlog', () => {
  it('lists entries, sorts by duration and resets after confirmation', async () => {
    show('redis.slowlog');
    await waitFor(() => expect(document.querySelectorAll('.redis-table tbody tr').length).toBe(24));
    fireEvent.click(screen.getByRole('button', { name: /Duration/ }));
    const durations = [...document.querySelectorAll('.redis-table tbody tr td:nth-child(3)')].map((c) => c.textContent);
    expect(durations[0]).toMatch(/ms|s/);
    expect(screen.getByLabelText('Slower than (µs)')).toHaveValue('10000');
    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Reset slowlog' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(env.hits('/slowlog/reset', 'POST')).toHaveLength(1));
    await waitFor(() => expect(screen.getByText('The slowlog is empty.')).toBeInTheDocument());
  });

  it('changes the threshold with CONFIG SET after confirmation', async () => {
    show('redis.slowlog');
    const input = await screen.findByLabelText('Slower than (µs)');
    await waitFor(() => expect(input).toHaveValue('10000'));
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'CONFIG SET' }));
    await waitFor(() => expect(env.hits('/config', 'PUT')).toHaveLength(1));
    expect(env.hits('/config', 'PUT')[0].body).toEqual({ name: 'slowlog-log-slower-than', value: '5000' });
  });
});

describe('info', () => {
  it('shows tiles from the polled INFO and searchable sections', async () => {
    show('redis.info');
    await waitFor(() => expect(screen.getByRole('group', { name: 'Used memory' })).toBeInTheDocument());
    expect(screen.getByRole('group', { name: 'Hit ratio' }).textContent).toMatch(/%/);
    expect(screen.getByRole('group', { name: 'Role' }).textContent).toContain('master');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search INFO' }), { target: { value: 'maxmemory_policy' } });
    expect(screen.getByText('noeviction')).toBeInTheDocument();
  });

  it('lists clients and kills one after confirmation', async () => {
    show('redis.info');
    fireEvent.click(await screen.findByRole('tab', { name: /Clients/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Kill client 12' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Kill client 12' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Kill client' })).getByRole('button', { name: 'Kill client' }));
    await waitFor(() => expect(env.hits('/clients/kill', 'POST')[0]?.body).toEqual({ id: '12' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Kill client 12' })).toBeNull());
  });

  it('MONITOR starts only after the warning and streams lines', async () => {
    show('redis.info', { monitor: true });
    fireEvent.click(await screen.findByRole('button', { name: /Start MONITOR/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Start MONITOR' });
    expect(dlg.textContent).toMatch(/throughput/);
    expect(dlg.textContent).toMatch(/stops by itself after 10 minutes/);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Start MONITOR' }));
    await waitFor(() => expect(screen.getByRole('log', { name: 'Monitor output' }).textContent).toMatch(/\[\d+ 10\.0\.1\./), { timeout: 3000 });
    expect((await api.listStreams()).find((s) => s.kind === 'redis.monitor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(async () => expect((await api.listStreams()).filter((s) => s.kind === 'redis.monitor')).toHaveLength(0));
  });
});

describe('analysis', () => {
  it('runs the job with progress and shows namespaces, top keys and TTL buckets', async () => {
    show('redis.analysis');
    fireEvent.click(await screen.findByRole('button', { name: /Analyze/ }));
    await waitFor(() => expect(screen.getByRole('table', { name: 'Namespaces' })).toBeInTheDocument(), { timeout: 4000 });
    expect(env.hits('/analysis', 'POST')[0].body).toEqual({ db: 0, sampleLimit: 100000, delimiter: ':' });
    expect(screen.getByRole('table', { name: 'Namespaces' }).textContent).toContain('user:');
    expect(screen.getByRole('table', { name: 'Top keys' }).querySelectorAll('tbody tr').length).toBe(100);
    expect(screen.getByText('No TTL')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keys' }));
    fireEvent.click(within(screen.getByRole('table', { name: 'Namespaces' })).getByRole('button', { name: /user:/ }));
    expect(document.querySelectorAll('.redis-sub-row').length).toBeGreaterThan(0);
  });

  it('can be cancelled', async () => {
    show('redis.analysis');
    fireEvent.click(await screen.findByRole('button', { name: /Analyze/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Cancel/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Analyze/ })).toBeInTheDocument());
    expect(screen.queryByRole('table', { name: 'Namespaces' })).toBeNull();
  });
});
