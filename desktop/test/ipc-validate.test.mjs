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
