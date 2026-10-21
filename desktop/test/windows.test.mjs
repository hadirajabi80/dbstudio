// Detached tab windows (src/main/windows-core.ts): payload validation of the `// ---- windows` IPC channels and the
// registry of detached windows, driven by fake BrowserWindows.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { desktopRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const w = require(join(desktopRoot, 'out', 'lib', 'windows-core.js'));
const { ValidationError } = w;

const consoleTab = (id = 't_1', extra = {}) => ({
  kind: 'console', id, title: 'Console 1', connectionId: 'c1', database: 'shop', text: 'select 1', savedText: '', filePath: null, txMode: 'auto', maxRows: null, ...extra,
});

describe('validateTabs', () => {
  it('accepts serialized console, object and view tabs and returns plain copies', () => {
    const tabs = [consoleTab(), { kind: 'object', id: 'o_1', title: 'Orders', connectionId: 'c1', database: null, ref: { schema: 'dbo', name: 'Orders', type: 'table' } },
      { kind: 'view', id: 'v_1', title: 'Data: Orders', view: 'data', connectionId: 'c1', database: null, state: { page: 1 } }];
    const out = w.validateTabs(tabs);
    assert.deepEqual(out, tabs);
    assert.notEqual(out[0], tabs[0]);
  });
  it('rejects malformed tabs', () => {
    const bad = [
      'x', null, [{}], [{ ...consoleTab(), id: '' }], [{ ...consoleTab(), id: 'a b' }], [{ ...consoleTab(), id: 'x'.repeat(200) }],
      [{ ...consoleTab(), kind: 'shell' }], [{ ...consoleTab(), title: 3 }], [{ kind: 'view', id: 'v', title: 'V' }],
      [consoleTab('t_1'), consoleTab('t_1')], Array.from({ length: 51 }, (_, i) => consoleTab(`t_${i}`)),
    ];
    for (const b of bad) assert.throws(() => w.validateTabs(b), ValidationError, JSON.stringify(b)?.slice(0, 80));
  });
  it('caps the payload size', () => {
    assert.throws(() => w.validateTabs([consoleTab('t_big', { text: 'x'.repeat(w.WINDOW_LIMITS.payloadChars) })]), /too large/);
  });
});

describe('validateOpenTabWindowArgs', () => {
  it('needs at least one tab and rounds/clamps the position', () => {
    assert.deepEqual(w.validateOpenTabWindowArgs({ tabs: [consoleTab()], position: { x: 10.6, y: -1e9 } }).position, { x: 11, y: -100000 });
    assert.equal(w.validateOpenTabWindowArgs({ tabs: [consoleTab()] }).position, undefined);
    assert.throws(() => w.validateOpenTabWindowArgs({ tabs: [] }), ValidationError);
    assert.throws(() => w.validateOpenTabWindowArgs({ tabs: [consoleTab()], position: { x: 'a', y: 1 } }), ValidationError);
    assert.throws(() => w.validateOpenTabWindowArgs({ tabs: [consoleTab()], position: { x: Infinity, y: 1 } }), ValidationError);
    assert.throws(() => w.validateOpenTabWindowArgs(null), ValidationError);
  });
});

describe('secondaryWindowBounds', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  it('opens near the drop point, inside the work area', () => {
    assert.deepEqual(w.secondaryWindowBounds({ x: 1000, y: 300 }, area), { x: 820, y: 240, width: 1100, height: 760 });
    const edge = w.secondaryWindowBounds({ x: 1910, y: 1030 }, area);
    assert.equal(edge.x + edge.width, 1920);
    assert.equal(edge.y + edge.height, 1040);
  });
  it('without a position: offset from the main window; small screens get a smaller window', () => {
    assert.deepEqual(w.secondaryWindowBounds(undefined, area, { x: 100, y: 50, width: 1400, height: 900 }), { x: 148, y: 98, width: 1100, height: 760 });
    const small = w.secondaryWindowBounds(undefined, { x: 0, y: 0, width: 700, height: 480 });
    assert.deepEqual(small, { x: 40, y: 40, width: 640, height: 420 });
  });
});

class FakeWindow {
  static seq = 0;
  constructor() {
    this.destroyed = false;
    this.focused = 0;
    this.sent = [];
    this.listeners = {};
    this.webContents = { id: ++FakeWindow.seq, send: (channel, ...args) => this.sent.push([channel, ...args]) };
  }
  isDestroyed() { return this.destroyed; }
  focus() { this.focused++; }
  once(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
  close() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const fn of this.listeners.closed ?? []) fn();
  }
}

function setup() {
  const main = new FakeWindow();
  const created = [];
  const reg = new w.DetachedWindows({
    primary: () => main,
    create: (opts) => { const win = new FakeWindow(); win.opts = opts; created.push(win); return win; },
  });
  const last = (channel) => main.sent.filter((m) => m[0] === channel).at(-1)?.[1];
  return { main, created, reg, last };
}

describe('DetachedWindows', () => {
  it('opens a window per call, serves its tabs and keeps the main window informed', () => {
    const { reg, created, last } = setup();
    assert.equal(reg.open({ tabs: [consoleTab('t_1')], position: { x: 5, y: 6 } }), true);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].opts, { position: { x: 5, y: 6 } });
    const id = created[0].webContents.id;
    assert.equal(reg.isDetached(id), true);
    assert.deepEqual(reg.tabsOf(id).map((t) => t.id), ['t_1']);
    assert.equal(reg.tabsOf(9999), null);
    assert.deepEqual(last('dbstudio:detached-tabs').map((t) => t.id), ['t_1']);
    reg.update(id, [consoleTab('t_1', { text: 'select 2' }), consoleTab('t_2')]);
    assert.deepEqual(last('dbstudio:detached-tabs').map((t) => t.id), ['t_1', 't_2']);
    assert.equal(reg.tabsOf(id)[0].text, 'select 2');
    assert.deepEqual(reg.allTabs().map((t) => t.id), ['t_1', 't_2']);
  });

  it('reattach hands tabs to the main window and focuses it; the emptied window closes without a "closed" report', () => {
    const { reg, created, main, last } = setup();
    reg.open({ tabs: [consoleTab('t_1')] });
    const win = created[0];
    assert.equal(reg.reattach(win.webContents.id, [consoleTab('t_1')]), true);
    assert.deepEqual(last('dbstudio:tabs-reattached'), { tabs: [consoleTab('t_1')], closed: false });
    assert.equal(main.focused, 1);
    assert.deepEqual(last('dbstudio:detached-tabs'), []);
    reg.closeEmpty(win.webContents.id);
    assert.equal(win.destroyed, true);
    assert.equal(reg.size, 0);
    assert.equal(main.sent.filter((m) => m[0] === 'dbstudio:tabs-reattached').length, 1);
  });

  it('a window the user closes reports its tabs as closed (recently closed in the main window)', () => {
    const { reg, created, last } = setup();
    reg.open({ tabs: [consoleTab('t_1'), consoleTab('t_2')] });
    created[0].close();
    assert.deepEqual(last('dbstudio:tabs-reattached'), { tabs: [consoleTab('t_1'), consoleTab('t_2')], closed: true });
    assert.deepEqual(last('dbstudio:detached-tabs'), []);
  });

  it('closeAll (main window closed, app quitting) closes every window without reporting its tabs as closed', () => {
    const { reg, created, main } = setup();
    reg.open({ tabs: [consoleTab('t_1')] });
    reg.open({ tabs: [consoleTab('t_2')] });
    const before = main.sent.length;
    reg.closeAll();
    assert.ok(created.every((c) => c.destroyed));
    assert.equal(reg.size, 0);
    assert.equal(main.sent.slice(before).filter((m) => m[0] === 'dbstudio:tabs-reattached').length, 0);
    // Afterwards (macOS: a new main window) tabs can be detached again.
    assert.equal(reg.open({ tabs: [consoleTab('t_3')] }), true);
  });

  it('reattach fails while the main window is gone; nothing is sent to destroyed windows', () => {
    const { reg, created, main } = setup();
    reg.open({ tabs: [consoleTab('t_1')] });
    main.destroyed = true;
    const before = main.sent.length;
    assert.equal(reg.reattach(created[0].webContents.id, [consoleTab('t_1')]), false);
    assert.deepEqual(reg.tabsOf(created[0].webContents.id).map((t) => t.id), ['t_1']);
    assert.equal(main.sent.length, before);
  });

  it('limits the number of windows', () => {
    const { reg } = setup();
    for (let i = 0; i < w.WINDOW_LIMITS.windows; i++) assert.equal(reg.open({ tabs: [consoleTab(`t_${i}`)] }), true);
    assert.equal(reg.open({ tabs: [consoleTab('t_x')] }), false);
  });
});
