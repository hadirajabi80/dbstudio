// IPC argument validation, file helpers and CSP (electron-free modules from out/lib).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { desktopRoot } from './helpers.mjs';

const require = createRequire(import.meta.url);
const v = require(join(desktopRoot, 'out', 'lib', 'validate.js'));
const f = require(join(desktopRoot, 'out', 'lib', 'fs-utils.js'));
const { buildCsp } = require(join(desktopRoot, 'out', 'lib', 'csp.js'));

describe('validateFilePath (win32 rules)', () => {
  const ok = (p) => v.validateFilePath(p, 'path', 'win32');
  it('accepts absolute drive and UNC paths', () => {
    assert.equal(ok('C:\\work\\q.sql'), 'C:\\work\\q.sql');
    assert.equal(ok('C:/work/../work/q.sql'), 'C:\\work\\q.sql');
    assert.equal(ok('\\\\server\\share\\q.sql'), '\\\\server\\share\\q.sql');
  });
  it('rejects relative, rooted-without-drive, device and NUL paths and non-strings', () => {
    for (const bad of ['q.sql', '..\\q.sql', '\\q.sql', '\\\\?\\C:\\q.sql', '\\\\.\\PhysicalDrive0', 'C:\\a\0b', '', 42, null, undefined, {}]) {
      assert.throws(() => ok(bad), v.ValidationError, String(bad));
    }
  });
});

describe('dialog options', () => {
  it('normalizes filters', () => {
    const o = v.validateSaveDialogArgs({ title: 'Save', defaultPath: 'q.sql', filters: [{ name: 'SQL', extensions: ['sql', '.txt', '*.csv', '*'] }] });
    assert.deepEqual(o.filters, [{ name: 'SQL', extensions: ['sql', 'txt', 'csv', '*'] }]);
    assert.deepEqual(v.validateOpenDialogArgs(undefined), { title: undefined, filters: undefined, createIfMissing: false });
    assert.equal(v.validateOpenDialogArgs({ createIfMissing: true }).createIfMissing, true);
  });
  it('rejects malformed options', () => {
    assert.throws(() => v.validateSaveDialogArgs('x'));
    assert.throws(() => v.validateSaveDialogArgs({ filters: [{ name: 'x', extensions: ['../evil'] }] }));
    assert.throws(() => v.validateSaveDialogArgs({ filters: [{ name: 'x' }] }));
    assert.throws(() => v.validateOpenDialogArgs({ createIfMissing: 'yes' }));
    assert.throws(() => v.validateOpenDialogArgs({ title: 5 }));
  });
});

describe('validateExternalUrl', () => {
  it('allows http/https only', () => {
    assert.equal(v.validateExternalUrl('https://learn.microsoft.com/sql'), 'https://learn.microsoft.com/sql');
    assert.equal(v.validateExternalUrl('http://example.com'), 'http://example.com/');
    for (const bad of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'ms-settings:privacy', 'dbstudio://app/', 'https://u:p@example.com', 'not a url', '', 7]) {
      assert.throws(() => v.validateExternalUrl(bad), v.ValidationError, String(bad));
    }
  });
});

describe('misc validation', () => {
  it('title is sanitized and capped', () => {
    assert.equal(v.validateTitle('a\nb\tc'), 'a b c');
    assert.equal(v.validateTitle('x'.repeat(1000)).length, 300);
    assert.throws(() => v.validateTitle(1));
  });
  it('workspace must be JSON-serializable', () => {
    assert.equal(v.serializeWorkspace({ a: 1 }), '{"a":1}');
    assert.equal(v.serializeWorkspace(null), 'null');
    assert.throws(() => v.serializeWorkspace(undefined));
    const cyclic = {}; cyclic.self = cyclic;
    assert.throws(() => v.serializeWorkspace(cyclic));
    assert.throws(() => v.validateFileContent(5));
  });
  it('file content is text or bytes (binary exports such as .xlsx)', () => {
    assert.equal(v.validateFileContent('select 1'), 'select 1');
    const bytes = v.validateFileContent(new Uint8Array([0x50, 0x4b, 3, 4]));
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual([...bytes], [0x50, 0x4b, 3, 4]);
    const view = v.validateFileContent(Buffer.from([1, 2, 3]).subarray(1));
    assert.deepEqual([...view], [2, 3]);
    for (const bad of [5, null, undefined, {}, [1, 2], new DataView(new ArrayBuffer(2))]) assert.throws(() => v.validateFileContent(bad), v.ValidationError);
  });
});

describe('update and window-chrome IPC', () => {
  it('updates.check takes an optional { manual: boolean }', () => {
    assert.deepEqual(v.validateUpdateCheckArgs(undefined), { manual: false });
    assert.deepEqual(v.validateUpdateCheckArgs({}), { manual: false });
    assert.deepEqual(v.validateUpdateCheckArgs({ manual: true }), { manual: true });
    for (const bad of [{ manual: 'yes' }, { manual: 1 }, 'x', [], 5]) assert.throws(() => v.validateUpdateCheckArgs(bad), v.ValidationError, JSON.stringify(bad));
  });

  it('updates.configure needs { autoCheck: boolean }', () => {
    assert.deepEqual(v.validateUpdateConfig({ autoCheck: false }), { autoCheck: false });
    assert.deepEqual(v.validateUpdateConfig({ autoCheck: true, extra: 1 }), { autoCheck: true }, 'unknown keys are dropped');
    for (const bad of [undefined, null, {}, { autoCheck: 'true' }, { autoCheck: 1 }, [true]]) {
      assert.throws(() => v.validateUpdateConfig(bad), v.ValidationError, JSON.stringify(bad));
    }
  });

  it('setTitleBarTheme: theme setting, hex colours only, height clamped', () => {
    assert.deepEqual(
      v.validateTitleBarTheme({ theme: 'dark', color: '#00000000', symbolColor: '#e6e8eb', height: 40 }),
      { theme: 'dark', color: '#00000000', symbolColor: '#e6e8eb', height: 40 },
    );
    assert.deepEqual(v.validateTitleBarTheme({ theme: 'system', color: '#F5F6F8', symbolColor: '#1c1f24' }), { theme: 'system', color: '#F5F6F8', symbolColor: '#1c1f24' });
    assert.equal(v.validateTitleBarTheme({ theme: 'light', color: '#ffffff', symbolColor: '#000000', height: 3 }).height, 24);
    assert.equal(v.validateTitleBarTheme({ theme: 'light', color: '#ffffff', symbolColor: '#000000', height: 79.6 }).height, 80);
    assert.equal(v.validateTitleBarTheme({ theme: 'light', color: '#ffffff', symbolColor: '#000000', height: 1e9 }).height, 96);
    const ok = { theme: 'light', color: '#ffffff', symbolColor: '#000000' };
    for (const bad of [
      null, 'dark', { ...ok, theme: 'blue' }, { ...ok, theme: undefined },
      { ...ok, color: 'red' }, { ...ok, color: 'rgb(0,0,0)' }, { ...ok, color: '#fff' }, { ...ok, color: '#ffffff; x' }, { ...ok, color: 7 },
      { ...ok, symbolColor: '#00000000' }, { ...ok, symbolColor: 'white' },
      { ...ok, height: '40' }, { ...ok, height: Number.NaN }, { ...ok, height: Infinity },
    ]) assert.throws(() => v.validateTitleBarTheme(bad), v.ValidationError, JSON.stringify(bad));
  });

  it('showAppMenu: a finite point, rounded and clamped', () => {
    assert.deepEqual(v.validateMenuPosition({ x: 10.4, y: 40.6 }), { x: 10, y: 41 });
    assert.deepEqual(v.validateMenuPosition({ x: -5, y: 1e12 }), { x: 0, y: 100_000 });
    for (const bad of [undefined, null, {}, { x: 1 }, { x: '1', y: 2 }, { x: Number.NaN, y: 0 }, [1, 2]]) {
      assert.throws(() => v.validateMenuPosition(bad), v.ValidationError, JSON.stringify(bad));
    }
  });
});

describe('fs-utils', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbstudio-test-'));
  it('atomicWriteFile replaces content and leaves no temp files', async () => {
    const file = join(dir, 'workspace.json');
    await f.atomicWriteFile(file, '{"v":1}');
    await f.atomicWriteFile(file, '{"v":2}');
    assert.equal(readFileSync(file, 'utf8'), '{"v":2}');
    assert.deepEqual(readdirSync(dir), ['workspace.json']);
  });
  it('serial queue keeps concurrent saves ordered', async () => {
    const q = new f.SerialQueue();
    const file = join(dir, 'ordered.json');
    await Promise.all(Array.from({ length: 20 }, (_, i) => q.run(() => f.atomicWriteFile(file, String(i)))));
    assert.equal(readFileSync(file, 'utf8'), '19');
  });
  it('decodes UTF-8, UTF-8 BOM, UTF-16 LE and BE', async () => {
    const text = 'SELECT N\'Grüße\' -- ✓';
    const variants = {
      'u8.sql': Buffer.from(text, 'utf8'),
      'u8bom.sql': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
      'u16le.sql': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
      'u16be.sql': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]),
    };
    for (const [name, buf] of Object.entries(variants)) {
      writeFileSync(join(dir, name), buf);
      assert.equal(await f.readTextFileDecoded(join(dir, name), 1024), text, name);
    }
    await assert.rejects(f.readTextFileDecoded(join(dir, 'u8.sql'), 4), /too large/);
    await assert.rejects(f.readTextFileDecoded(dir, 1024), /Not a file/);
  });
});

describe('CSP', () => {
  it('production policy allows the loopback engine and Monaco needs, nothing else', () => {
    const csp = buildCsp();
    assert.match(csp, /connect-src 'self' dbstudio: http:\/\/127\.0\.0\.1:\* ws:\/\/127\.0\.0\.1:\*(;|$)/);
    assert.match(csp, /style-src 'self' dbstudio: 'unsafe-inline'/);
    assert.match(csp, /worker-src 'self' dbstudio: blob:/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.doesNotMatch(csp, /localhost/);
  });
  it('dev policy adds the Vite origin and its HMR socket', () => {
    const csp = buildCsp('http://localhost:5173/');
    assert.match(csp, /script-src[^;]*http:\/\/localhost:5173 'unsafe-inline'/);
    assert.match(csp, /connect-src[^;]*ws:\/\/localhost:5173/);
  });
});
