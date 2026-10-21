// Pure Redis UI logic: redis-cli quoting, the command table, completion, formatting, the delimiter key tree, globs.
import { describe, expect, it } from 'vitest';
import type { RedisKeySummary } from '../../api/types';
import { ArgsError, commandLines, joinArgs, lineContext, parseArgs, quoteArg, tryParseArgs } from '../args';
import { COMMANDS, CONTAINERS, commandDoc, findCommand, getCommand, helpText, isKeyArgument, isReadOnlyCommand, isRefusedCommand, subCommands, syntaxKeywords, syntaxPlaceholders } from '../catalog';
import { signature, suggest } from '../complete';
import { formatBytes, formatCount, formatScore, formatTtl, parseDuration, prettyJson, replyTable, replyText } from '../format';
import { globMatch, hasGlob } from '../glob';
import { ancestors, buildKeyIndex, flattenKeyTree, folderPattern } from '../keyTree';

describe('parseArgs (redis-cli quoting)', () => {
  it('splits words and keeps quoted spaces', () => {
    expect(parseArgs('SET k "a b"')).toEqual(['SET', 'k', 'a b']);
    expect(parseArgs("SET k 'a b'")).toEqual(['SET', 'k', 'a b']);
    expect(parseArgs('  GET   key  ')).toEqual(['GET', 'key']);
  });
  it('handles escapes and hex bytes in double quotes only', () => {
    expect(parseArgs('"a\\nb\\t\\"c\\""')).toEqual(['a\nb\t"c"']);
    expect(parseArgs('"\\x41\\x42"')).toEqual(['AB']);
    expect(parseArgs("'it\\'s \\n'")).toEqual(["it's \\n"]);
  });
  it('accepts empty strings and quotes inside words', () => {
    expect(parseArgs('SET k ""')).toEqual(['SET', 'k', '']);
    expect(parseArgs('a"b c"')).toEqual(['ab c']);
  });
  it('rejects unbalanced quotes and a quote glued to text', () => {
    expect(() => parseArgs('SET k "abc')).toThrow(ArgsError);
    expect(() => parseArgs("SET k 'abc")).toThrow(ArgsError);
    expect(() => parseArgs('SET k "a"b')).toThrow(/followed by a space/);
    expect(tryParseArgs('SET "x')).toBeNull();
  });
  it('quoteArg round-trips through parseArgs', () => {
    for (const v of ['plain', 'a b', '', 'say "hi"', 'back\\slash', 'line\nbreak', "it's", 'ü:ключ']) {
      expect(parseArgs(quoteArg(v))).toEqual([v]);
    }
    expect(quoteArg('user:1')).toBe('user:1');
    expect(joinArgs(['SET', 'a b', 'c'])).toBe('SET "a b" c');
  });
  it('lineContext gives the finished args and the partial word', () => {
    expect(lineContext('HGET user')).toMatchObject({ args: ['HGET'], current: 'user', start: 5 });
    expect(lineContext('HGET user ')).toMatchObject({ args: ['HGET', 'user'], current: '', start: 10 });
    expect(lineContext('SET "a b')).toMatchObject({ args: ['SET'], current: 'a b', inQuote: '"' });
  });
  it('commandLines skips blanks and comments', () => {
    expect(commandLines('# c\nPING\n\n// x\n  GET k  ')).toEqual([{ line: 'PING', lineNumber: 2 }, { line: 'GET k', lineNumber: 5 }]);
  });
});

describe('command table', () => {
  it('has the core commands with docs and flags', () => {
    expect(COMMANDS.length).toBeGreaterThan(200);
    expect(getCommand('get')?.flags).toContain('readonly');
    expect(isReadOnlyCommand(getCommand('SET'))).toBe(false);
    expect(isRefusedCommand(getCommand('MONITOR'))).toBe(true);
    expect(CONTAINERS.has('CONFIG')).toBe(true);
    expect(subCommands('xgroup').map((c) => c.name)).toContain('XGROUP CREATE');
  });
  it('finds two-word container commands first', () => {
    expect(findCommand(['config', 'get', 'x'])?.name).toBe('CONFIG GET');
    expect(findCommand(['config'])).toBeUndefined();
    expect(findCommand(['GET', 'k'])?.name).toBe('GET');
  });
  it('knows which arguments are keys', () => {
    const del = getCommand('DEL');
    expect(isKeyArgument(del, 1, 3)).toBe(true);
    expect(isKeyArgument(del, 2, 3)).toBe(true);
    const mset = getCommand('MSET');
    expect(isKeyArgument(mset, 1, 5)).toBe(true);
    expect(isKeyArgument(mset, 2, 5)).toBe(false);
    expect(isKeyArgument(mset, 3, 5)).toBe(true);
    expect(isKeyArgument(getCommand('SET'), 2, 3)).toBe(false);
    expect(isKeyArgument(getCommand('OBJECT ENCODING'), 2, 3)).toBe(true);
  });
  it('documents a command for hover and help', () => {
    const doc = commandDoc(getCommand('ZADD')!);
    expect(doc).toContain('**ZADD**');
    expect(doc).toContain('since 1.2.0');
    expect(helpText('zadd')).toContain('ZADD key');
    expect(helpText('nope')).toBeNull();
    expect(syntaxKeywords(getCommand('SET')!)).toEqual(expect.arrayContaining(['NX', 'XX', 'EX', 'KEEPTTL', 'GET']));
    expect(syntaxPlaceholders(getCommand('SETEX')!)).toEqual(['key', 'seconds', 'value']);
  });
});

describe('completion', () => {
  const keys = () => ['user:1', 'user:2', 'session:x', 'a b'];
  it('completes command names case-insensitively', () => {
    const r = suggest('hge');
    expect(r.items.map((i) => i.label)).toEqual(expect.arrayContaining(['HGET', 'HGETALL']));
    expect(r.items[0].spec?.summary).toBeTruthy();
    expect(r.start).toBe(0);
  });
  it('completes sub-commands of containers', () => {
    expect(suggest('CONFIG ').items.map((i) => i.label)).toEqual(expect.arrayContaining(['GET', 'SET']));
    expect(suggest('XGROUP CR').items.map((i) => i.label)).toEqual(['CREATE', 'CREATECONSUMER']);
  });
  it('completes cached key names for key arguments, quoting when needed', () => {
    expect(suggest('GET us', keys).items.map((i) => i.label)).toEqual(['user:1', 'user:2']);
    expect(suggest('DEL user:1 se', keys).items.map((i) => i.label)).toEqual(['session:x']);
    expect(suggest('GET a', keys).items[0].insert).toBe('"a b"');
  });
  it('completes keywords for non-key arguments', () => {
    const labels = suggest('SET k v ').items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['NX', 'EX', 'KEEPTTL']));
    expect(suggest('SET k v NX ').items.map((i) => i.label)).not.toContain('NX');
  });
  it('signature names the placeholder being typed', () => {
    expect(signature('SETEX k ')?.placeholder).toBe('seconds');
    expect(signature('CONFIG SET ')?.spec.name).toBe('CONFIG SET');
    expect(signature('')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats TTLs and durations', () => {
    expect(formatTtl(-1)).toBe('');
    expect(formatTtl(-2)).toBe('gone');
    expect(formatTtl(45)).toBe('45s');
    expect(formatTtl(3600 + 12 * 60)).toBe('1h 12m');
    expect(formatTtl(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('soon')).toBeNull();
  });
  it('formats sizes, counts and infinite scores', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatCount(1284)).toBe('1,284');
    expect(formatCount(2_100_000)).toBe('2.1M');
    expect(formatScore(Number.MAX_VALUE)).toBe('+inf');
    expect(formatScore(-Number.MAX_VALUE)).toBe('-inf');
  });
  it('renders replies like redis-cli', () => {
    expect(replyText({ type: 'simple', value: 'OK' })).toBe('OK');
    expect(replyText({ type: 'bulk', value: 'a b' })).toBe('"a b"');
    expect(replyText({ type: 'int', value: 3 })).toBe('(integer) 3');
    expect(replyText({ type: 'null', value: null })).toBe('(nil)');
    expect(replyText({ type: 'error', value: 'ERR x' })).toBe('(error) ERR x');
    expect(replyText({ type: 'array', value: [] })).toBe('(empty array)');
    expect(replyText({ type: 'array', value: ['a', ['b', 1]] })).toBe('1) "a"\n2) 1) "b"\n   2) (integer) 1');
    expect(replyText({ type: 'bulk', value: '# Server\r\nversion:7' })).toBe('# Server\nversion:7');
  });
  it('detects tables and JSON', () => {
    expect(replyTable('HGETALL', ['HGETALL', 'h'], ['f', 'v', 'g', 'w'])).toEqual({ columns: ['field', 'value'], rows: [['f', 'v'], ['g', 'w']] });
    expect(replyTable('ZRANGE', ['ZRANGE', 'z', '0', '-1', 'WITHSCORES'], ['a', '1'])?.columns).toEqual(['member', 'score']);
    expect(replyTable('XINFO GROUPS', [], [['name', 'g1', 'pending', 2], ['name', 'g2', 'pending', 0]])).toEqual({ columns: ['name', 'pending'], rows: [['g1', '2'], ['g2', '0']] });
    expect(replyTable('GET', [], 'x')).toBeNull();
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('not json')).toBeNull();
  });
});

describe('key tree and globs', () => {
  const k = (key: string, type: RedisKeySummary['type'] = 'string'): RedisKeySummary => ({ key, type, ttl: -1 });
  const keys = [k('user:1001:profile', 'hash'), k('user:1001:cart', 'list'), k('user:1002:profile', 'hash'), k('session:abc'), k('greeting'), k('a:')];
  it('groups by delimiter with counts, folders first', () => {
    const rows = flattenKeyTree(buildKeyIndex(keys, ':'), new Set());
    expect(rows.map((r) => r.label)).toEqual(['session', 'user', 'a:', 'greeting']);
    expect(rows.find((r) => r.kind === 'folder' && r.label === 'user')).toMatchObject({ count: 3 });
  });
  it('expands folders and shows the key tail', () => {
    const rows = flattenKeyTree(buildKeyIndex(keys, ':'), new Set(['user:', 'user:1001:']));
    expect(rows.map((r) => `${r.depth}:${r.label}`)).toEqual(['0:session', '0:user', '1:1001', '2:cart', '2:profile', '1:1002', '0:a:', '0:greeting']);
  });
  it('sorts numerically and supports other delimiters', () => {
    const rows = flattenKeyTree(buildKeyIndex([k('n/10'), k('n/9'), k('n/100')], '/'), new Set(['n/']));
    expect(rows.slice(1).map((r) => r.label)).toEqual(['9', '10', '100']);
    expect(ancestors('a:b:c', ':')).toEqual(['a:', 'a:b:']);
    expect(folderPattern('user[1]:')).toBe('user\\[1\\]:*');
  });
  it('matches Redis globs', () => {
    expect(globMatch('user:*', 'user:1')).toBe(true);
    expect(globMatch('user:?', 'user:12')).toBe(false);
    expect(globMatch('h[ae]llo', 'hello')).toBe(true);
    expect(globMatch('h[^e]llo', 'hello')).toBe(false);
    expect(globMatch('a\\*b', 'a*b')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(hasGlob('user:*')).toBe(true);
    expect(hasGlob('user:1')).toBe(false);
  });
});
