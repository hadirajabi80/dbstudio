// Key browser against the MSW Redis mock (5k keys): scan + tree/flat, filters, badges, every value editor, the
// add / rename / TTL / delete flows with confirmations, delete-by-pattern job, read-only, keyboard.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installKeyDispatcher } from '../../../commands/dispatcher';
import { runCommand } from '../../../commands/registry';
import { useConnections } from '../../../store/connections';
import { useTabs } from '../../../store/tabs';
import { useUi } from '../../../store/ui';
import { registerRedisCommands } from '../commands';
import { openBrowser, type BrowserState } from '../open';
import { installRedisEngine, RedisHost, resetTabs, stubClipboard, tabState, until } from './kit';

const env = installRedisEngine();
let clipboard: string[] = [];

beforeAll(() => {
  registerRedisCommands();
  installKeyDispatcher();
});
beforeEach(() => {
  env.reset();
  resetTabs();
  clipboard = stubClipboard();
});

async function show(patch: Partial<BrowserState> = {}) {
  const id = openBrowser('c_redis', { db: 0, ...patch });
  render(<RedisHost tabId={id} />);
  await until(() => !!document.querySelector('.redis-keyrow'));
  return id;
}

const keyRows = () => [...document.querySelectorAll('.redis-keyrow')].map((r) => r.textContent ?? '');
const row = (text: string) => [...document.querySelectorAll<HTMLElement>('.redis-keyrow')].find((r) => (r.textContent ?? '').includes(text))!;
const confirmDialog = () => screen.getByRole('dialog');

describe('scan, tree and filters', () => {
  it('scans the first page into a delimiter tree with counts and the scan status', async () => {
    await show();
    expect(keyRows().some((t) => t.startsWith('user'))).toBe(true);
    expect(env.hits('/keys/scan', 'POST').length).toBeGreaterThan(0);
    expect(document.querySelector('.redis-scan-status')?.textContent).toMatch(/keys · scanned [\d,]+ of ~5,000/);
    expect(screen.getByRole('button', { name: 'Scan more' })).toBeEnabled();
  });

  it('Scan more continues the cursor', async () => {
    await show();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan more' })).toBeEnabled(), { timeout: 4000 });
    const scans = env.hits('/keys/scan', 'POST').length;
    fireEvent.click(screen.getByRole('button', { name: 'Scan more' }));
    await waitFor(() => expect(env.hits('/keys/scan', 'POST').length).toBeGreaterThan(scans), { timeout: 4000 });
    await until(() => env.hits('/keys/scan', 'POST').at(-1)!.body !== null);
    expect((env.hits('/keys/scan', 'POST').at(-1)!.body as { cursor: string }).cursor).not.toBe('0');
    await waitFor(() => expect(Number(document.querySelector('.redis-scan-status')!.textContent!.split(' ')[0].replace(/,/g, ''))).toBeGreaterThan(500), { timeout: 4000 });
  });

  it('expands folders and shows type badges and TTLs', async () => {
    await show({ pattern: 'session:*' });
    await waitFor(() => expect(keyRows()[0]).toMatch(/^session/));
    fireEvent.click(row('session'));
    await waitFor(() => expect(document.querySelectorAll('.redis-keyrow').length).toBeGreaterThan(1));
    const key = document.querySelectorAll('.redis-keyrow')[1];
    expect(key.textContent).toContain('STRING');
    expect(key.querySelector('.redis-ttl')!.textContent).toMatch(/\d+[smhd]/);
  });

  it('a plain pattern means "contains"; the type filter uses SCAN TYPE', async () => {
    const id = await show({ tree: false });
    const input = screen.getByRole('searchbox', { name: 'Key pattern' });
    fireEvent.change(input, { target: { value: 'leaderboard' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(keyRows()).toHaveLength(2));
    expect((env.hits('/keys/scan', 'POST').at(-1)!.body as { pattern: string }).pattern).toBe('*leaderboard*');
    act(() => useTabs.getState().updateView(id, { state: { ...tabState<BrowserState>(id), pattern: '', type: 'stream' } }));
    await waitFor(() => expect(keyRows().every((t) => t.includes('STREAM'))).toBe(true));
    expect((env.hits('/keys/scan', 'POST').at(-1)!.body as { type: string }).type).toBe('stream');
  });

  it('the flat list shows full key names; memory badges load for visible rows', async () => {
    await show({ tree: false, pattern: 'user:1001:*' });
    await waitFor(() => expect(keyRows()).toHaveLength(2));
    expect(keyRows()[0]).toContain('user:1001:cart');
    await waitFor(() => expect(env.hits('/keys/memory', 'POST').length).toBeGreaterThan(0), { timeout: 2000 });
    await waitFor(() => expect(row('user:1001:profile').querySelector('.redis-size')!.textContent).toMatch(/B$/));
  });

  it('switches database from the toolbar', async () => {
    const id = await show();
    act(() => useTabs.getState().updateView(id, { state: { ...tabState<BrowserState>(id), db: 1 } }));
    await waitFor(() => expect(keyRows().join(' ')).toContain('jobs'));
    expect((env.hits('/keys/scan', 'POST').at(-1)!.body as { db: number }).db).toBe(1);
  });
});

describe('value editors', () => {
  it('hash: edits a field, adds one, deletes one and saves with one request', async () => {
    await show({ tree: false, pattern: 'user:1001:profile', selected: 'user:1001:profile' });
    await screen.findByText('alice1001@example.com', {}, { timeout: 3000 }).catch(() => null);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Value of name/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^Value of tier/ }));
    const edit = screen.getByRole('textbox', { name: 'Edit Value of tier' });
    fireEvent.change(edit, { target: { value: 'diamond' } });
    fireEvent.keyDown(edit, { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox', { name: 'New field' }), { target: { value: 'nickname' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'New value' }), { target: { value: 'Ali' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete visits' }));
    expect(screen.getByText('3 pending changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.hits('/hash', 'POST')).toHaveLength(1));
    expect(env.hits('/hash', 'POST')[0].body).toEqual({ set: { tier: 'diamond', nickname: 'Ali' }, del: ['visits'] });
    await waitFor(() => expect(screen.queryByText(/pending change/)).toBeNull());
  });

  it('string: JSON values get Pretty and save with Ctrl+S', async () => {
    await show({ tree: false, pattern: 'config:*', selected: 'config:feature-flags' });
    const editor = await screen.findByRole('textbox', { name: 'Value of config:feature-flags' });
    expect(screen.getByText('JSON')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pretty' }));
    expect((editor as HTMLTextAreaElement).value).toContain('\n  "darkMode": true');
    fireEvent.keyDown(editor, { key: 's', ctrlKey: true });
    await waitFor(() => expect(env.hits('/string', 'PUT')).toHaveLength(1));
    expect((env.hits('/string', 'PUT')[0].body as { value: string }).value).toContain('"darkMode": true');
  });

  it('string: binary values show a read-only hex dump', async () => {
    await show({ tree: false, pattern: 'bin:*', selected: 'bin:thumbnail' });
    expect(await screen.findByLabelText('Hex dump')).toHaveTextContent('89 50 4e 47');
    expect(screen.getByText(/Binary · hex · read-only/)).toBeInTheDocument();
  });

  it('list: pages, pushes and sets an element', async () => {
    await show({ tree: false, pattern: 'queue:emails', selected: 'queue:emails' });
    expect(await screen.findByText(/Items 0–199 of 640/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next ›' }));
    expect(await screen.findByText(/Items 200–399 of 640/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'LPUSH' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New element' }), { target: { value: 'urgent' } });
    fireEvent.click(screen.getByRole('button', { name: /Push/ }));
    await waitFor(() => expect(env.hits('/list', 'POST')).toHaveLength(1));
    expect(env.hits('/list', 'POST')[0].body).toEqual({ push: { side: 'left', values: ['urgent'] } });
  }, 30_000); // renders two pages of 200 editable rows in jsdom (~5 s alone; the default 15 s is tight on a busy machine)

  it('set: adds and removes members', async () => {
    await show({ tree: false, pattern: 'tags:post:1', selected: 'tags:post:1' });
    await screen.findByText(/of \d+ members/);
    fireEvent.change(screen.getByRole('textbox', { name: 'New member' }), { target: { value: 'valkey' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const first = document.querySelector('.redis-table tbody tr:not(.redis-row-added) td')!.textContent!;
    fireEvent.click(screen.getByRole('button', { name: `Delete ${first}` }));
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.hits('/set', 'POST')).toHaveLength(1));
    expect(env.hits('/set', 'POST')[0].body).toEqual({ add: ['valkey'], remove: [first] });
  });

  it('zset: sorted by score, edits a score', async () => {
    await show({ tree: false, pattern: 'leaderboard:daily', selected: 'leaderboard:daily' });
    await screen.findByText(/of 14 members/);
    const scores = [...document.querySelectorAll('.redis-table tbody tr td:nth-child(2)')].map((c) => Number(c.textContent));
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    fireEvent.click(screen.getByRole('button', { name: /^Score of alice/ }));
    const e = screen.getByRole('textbox', { name: 'Edit Score of alice' });
    fireEvent.change(e, { target: { value: '9999' } });
    fireEvent.keyDown(e, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.hits('/zset', 'POST')).toHaveLength(1));
    expect(env.hits('/zset', 'POST')[0].body).toEqual({ add: [{ member: 'alice', score: 9999 }] });
  });

  it('stream: newest first, groups with consumers and pending, ACK', async () => {
    await show({ tree: false, pattern: 'events:orders', selected: 'events:orders' });
    await screen.findByRole('tab', { name: /Entries \(260\)/ });
    const firstId = document.querySelector('.redis-table tbody tr td')!.textContent!;
    expect(firstId).toBe('1760000259000-0');
    fireEvent.click(screen.getByRole('tab', { name: /Consumer groups \(2\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'billing' }));
    expect((await screen.findAllByText('billing-1')).length).toBeGreaterThan(0);
    const ack = (await screen.findAllByRole('button', { name: 'ACK' }))[0];
    fireEvent.click(ack);
    await waitFor(() => expect(env.hits('/stream', 'POST')).toHaveLength(1));
    expect(env.hits('/stream', 'POST')[0].body).toMatchObject({ ack: { group: 'billing' } });
  });

  it('stream: adds an entry and loads older entries', async () => {
    await show({ tree: false, pattern: 'events:orders', selected: 'events:orders' });
    await screen.findByRole('tab', { name: /Entries/ });
    fireEvent.click(screen.getByRole('button', { name: 'Load older entries' }));
    await waitFor(() => expect(document.querySelectorAll('.redis-table tbody tr').length).toBe(200));
    expect(env.hits('stop=%28', 'GET').length).toBe(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Entry field 1' }), { target: { value: 'type' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Entry value 1' }), { target: { value: 'test' } });
    fireEvent.click(screen.getByRole('button', { name: 'XADD *' }));
    await waitFor(() => expect(env.hits('/stream', 'POST')).toHaveLength(1));
    expect(env.hits('/stream', 'POST')[0].body).toEqual({ add: { type: 'test' } });
  });

  it('RedisJSON: edits and saves the document with JSON.SET $', async () => {
    await show({ tree: false, pattern: 'doc:product:1', selected: 'doc:product:1' });
    const ed = await screen.findByRole('textbox', { name: 'Document doc:product:1' });
    expect((ed as HTMLTextAreaElement).value).toContain('"sku": "SKU-1001"');
    fireEvent.change(ed, { target: { value: '{"sku":"X"' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Invalid JSON');
    fireEvent.change(ed, { target: { value: '{"sku":"X"}' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(env.hits('/json', 'PUT')).toHaveLength(1));
    expect(env.hits('/json', 'PUT')[0].body).toEqual({ path: '$', value: { sku: 'X' } });
  });
});

describe('key actions', () => {
  it('adds a key from the dialog and selects it', async () => {
    const id = await show({ tree: false });
    fireEvent.click(screen.getByRole('button', { name: /^Key$/ }));
    const dlg = await screen.findByRole('dialog', { name: /New key/ });
    fireEvent.change(within(dlg).getByLabelText('Key'), { target: { value: 'new:thing' } });
    fireEvent.change(within(dlg).getByLabelText('TTL'), { target: { value: '15m' } });
    fireEvent.change(within(dlg).getByLabelText('Value'), { target: { value: 'hello' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add key' }));
    await waitFor(() => expect(env.hits('/redis/c_redis/keys', 'POST').some((r) => r.path === '/redis/c_redis/keys')).toBe(true));
    const body = env.hits('/redis/c_redis/keys', 'POST').find((r) => r.path === '/redis/c_redis/keys')!.body;
    expect(body).toEqual({ key: 'new:thing', db: 0, ttl: 900, type: 'string', value: 'hello' });
    await waitFor(() => expect(tabState<BrowserState>(id).selected).toBe('new:thing'));
  });

  it('renames the selected key (F2) and follows it', async () => {
    const id = await show({ tree: false, pattern: 'greeting', selected: 'greeting' });
    await screen.findByRole('textbox', { name: 'Value of greeting' });
    (document.querySelector('.redis-keylist') as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'F2' });
    const dlg = await screen.findByRole('dialog', { name: 'Rename key' });
    fireEvent.change(within(dlg).getByLabelText('New name'), { target: { value: 'salutation' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(tabState<BrowserState>(id).selected).toBe('salutation'));
    expect(env.hits('/rename', 'POST')[0].body).toEqual({ newKey: 'salutation', overwrite: false });
  });

  it('sets and removes a TTL', async () => {
    await show({ tree: false, pattern: 'greeting', selected: 'greeting' });
    await screen.findByRole('textbox', { name: 'Value of greeting' });
    fireEvent.click(screen.getByRole('button', { name: /TTL$/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Set TTL' });
    fireEvent.click(within(dlg).getByRole('button', { name: '1 hour' }));
    fireEvent.click(within(dlg).getByRole('button', { name: 'Set TTL' }));
    await waitFor(() => expect(env.hits('/ttl', 'PUT')).toHaveLength(1));
    expect(env.hits('/ttl', 'PUT')[0].body).toEqual({ seconds: 3600 });
    await waitFor(() => expect(row('greeting').querySelector('.redis-ttl')!.textContent).toMatch(/h/));
  });

  it('Delete asks for confirmation (Cancel keeps the key)', async () => {
    await show({ tree: false, pattern: 'greeting', selected: 'greeting' });
    await screen.findByRole('textbox', { name: 'Value of greeting' });
    (document.querySelector('.redis-keylist') as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Delete' });
    expect(await screen.findByRole('dialog', { name: 'Delete key' })).toBeInTheDocument();
    fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }));
    expect(env.hits('/keys/greeting', 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete key' })).getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(env.hits('/keys/greeting', 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(keyRows()).toHaveLength(0));
  });

  it('delete by pattern requires the typed count and reports progress', async () => {
    await show({ tree: false, pattern: 'tags:post:1*' });
    runCommand('redis.deletePattern');
    const dlg = await screen.findByRole('dialog', { name: 'Delete keys matching a pattern' });
    await waitFor(() => expect(within(dlg).getByRole('status')).toHaveTextContent(/permanently deletes 111 keys/));
    const go = within(dlg).getByRole('button', { name: /Delete 111 keys/ });
    expect(go).toBeDisabled();
    fireEvent.change(within(dlg).getByLabelText('Type the number of keys to confirm'), { target: { value: '111' } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() => expect(within(dlg).getByText('Deleted 111 keys.')).toBeInTheDocument(), { timeout: 4000 });
    expect(env.hits('/keys/delete-pattern', 'POST')[0].body).toEqual({ db: 0, pattern: 'tags:post:1*' });
  });

  it('copies the key name and the value as JSON', async () => {
    await show({ tree: false, pattern: 'user:1001:profile', selected: 'user:1001:profile' });
    await screen.findByRole('button', { name: /^Value of name/ });
    fireEvent.click(screen.getByRole('button', { name: /Copy name/ }));
    fireEvent.click(screen.getByRole('button', { name: /Copy JSON/ }));
    await waitFor(() => expect(clipboard).toHaveLength(2));
    expect(clipboard[0]).toBe('user:1001:profile');
    expect(JSON.parse(clipboard[1])).toMatchObject({ city: expect.any(String), tier: expect.any(String) });
  });
});

describe('read-only and keyboard', () => {
  it('a read-only connection disables every write in the browser', async () => {
    const c = useConnections.getState().connections.find((x) => x.id === 'c_redis')!;
    useConnections.setState({ connections: useConnections.getState().connections.map((x) => (x.id === 'c_redis' ? { ...x, readOnly: true } : x)) });
    env.engine.connections.find((x) => x.id === 'c_redis')!.readOnly = true;
    try {
      await show({ tree: false, pattern: 'user:1001:profile', selected: 'user:1001:profile' });
      await screen.findByRole('button', { name: /^Value of name/ }).catch(() => null);
      await waitFor(() => expect(screen.getAllByText(/read-only/).length).toBeGreaterThan(0));
      expect(screen.getByRole('button', { name: /^Key$/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Rename/ })).toBeDisabled();
      expect(screen.queryByRole('textbox', { name: 'New field' })).toBeNull();
    } finally {
      useConnections.setState({ connections: useConnections.getState().connections.map((x) => (x.id === 'c_redis' ? c : x)) });
    }
  });

  it('arrows move through the list and open keys; Ctrl+F focuses the pattern', async () => {
    const id = await show({ tree: false, pattern: 'leaderboard' });
    await waitFor(() => expect(keyRows()).toHaveLength(2));
    const list = document.querySelector('.redis-keylist') as HTMLElement;
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(tabState<BrowserState>(id).selected).toBe('leaderboard:weekly'));
    fireEvent.keyDown(list, { key: 'Home' });
    await waitFor(() => expect(tabState<BrowserState>(id).selected).toBe('leaderboard:daily'));
    fireEvent.keyDown(list, { key: 'f', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Key pattern' }));
  });

  it('tree keys: Right opens a folder, Enter selects', async () => {
    const id = await show({ pattern: 'user:1001:*' });
    const list = document.querySelector('.redis-keylist') as HTMLElement;
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    await waitFor(() => expect(keyRows().length).toBe(2));
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    await waitFor(() => expect(keyRows().length).toBe(4));
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    await waitFor(() => expect(tabState<BrowserState>(id).selected).toBe('user:1001:cart'));
  });
});

describe('ui store', () => {
  it('toasts on success', async () => {
    await show({ tree: false, pattern: 'greeting', selected: 'greeting' });
    await screen.findByRole('textbox', { name: 'Value of greeting' });
    fireEvent.click(screen.getByRole('button', { name: /Copy name/ }));
    await waitFor(() => expect(useUi.getState().toasts.some((t) => t.text === 'Key name copied')).toBe(true));
  });
});
