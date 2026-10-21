// Pure helpers of the Kafka UI (docs/PLAN-M2.md 7): formatting, ordering, lag heat, produce request building,
// config parsing.
import { describe, expect, it } from 'vitest';
import type { KafkaMessage } from '../../../api/types';
import { parseConfigLines } from '../dialogs';
import { decodedText, formatCount, isTruncated, lagClass, preview, prettyText, sortMessages, substitute } from '../format';
import { DEFAULT_DRAFT } from '../open';
import { buildProduceRequest, MAX_REPEAT } from '../Produce';

const msg = (partition: number, offset: number, ts: string): KafkaMessage => ({
  topic: 't', partition, offset, timestamp: ts, timestampType: 'create', key: { format: 'string', text: null },
  value: { format: 'string', text: `${partition}/${offset}` }, headers: [], size: 3,
});

describe('format', () => {
  it('formats counts compactly', () => {
    expect(formatCount(9999)).toBe('9,999');
    expect(formatCount(12_345)).toBe('12.3K');
    expect(formatCount(2_500_000)).toBe('2.5M');
    expect(formatCount(null)).toBe('');
  });

  it('reads plain, null and truncated payloads', () => {
    expect(decodedText({ format: 'string', text: null })).toBe('null');
    const t = { format: 'json' as const, text: { $trunc: 'abc', len: 99_999 } };
    expect(decodedText(t)).toBe('abc');
    expect(isTruncated(t)).toBe(true);
    expect(preview({ format: 'string', text: 'a\n  b' })).toBe('a b');
    expect(preview({ format: 'string', text: 'x'.repeat(200) }, 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('pretty-prints parsed JSON only', () => {
    expect(prettyText({ format: 'json', text: '{"a":1}', json: { a: 1 } }, true)).toBe('{\n  "a": 1\n}');
    expect(prettyText({ format: 'json', text: '{"a":1}', json: { a: 1 } }, false)).toBe('{"a":1}');
    expect(prettyText({ format: 'string', text: 'plain' }, true)).toBe('plain');
  });

  it('sorts newest first and oldest first, stable across partitions', () => {
    const list = [msg(0, 1, '2026-01-01T00:00:01Z'), msg(1, 5, '2026-01-01T00:00:03Z'), msg(2, 0, '2026-01-01T00:00:02Z')];
    expect(sortMessages(list, 'newest').map((m) => m.partition)).toEqual([1, 2, 0]);
    expect(sortMessages(list, 'oldest').map((m) => m.partition)).toEqual([0, 2, 1]);
  });

  it('colours lag by the thresholds', () => {
    expect(lagClass(5, 10, 100)).toBe('kafka-lag-ok');
    expect(lagClass(10, 10, 100)).toBe('kafka-lag-warn');
    expect(lagClass(500, 10, 100)).toBe('kafka-lag-danger');
    expect(lagClass(null, 10, 100)).toBe('kafka-lag-unknown');
  });

  it('substitutes ${i}', () => {
    expect(substitute('{"id":${i},"k":"k-${i}"}', 7)).toBe('{"id":7,"k":"k-7"}');
  });
});

describe('produce request', () => {
  it('repeats with ${i} in key, value and headers', () => {
    const r = buildProduceRequest({ ...DEFAULT_DRAFT, key: 'k${i}', value: '{"n":${i}}', headers: [{ key: 'h', value: 'v${i}' }], repeat: 3 });
    if (typeof r === 'string') throw new Error(r);
    expect(r.messages.map((m) => [m.key, m.value, m.headers?.[0].value])).toEqual([['k1', '{"n":1}', 'v1'], ['k2', '{"n":2}', 'v2'], ['k3', '{"n":3}', 'v3']]);
    expect(r.schema).toBeNull();
  });

  it('sends an empty key as null and keeps the partition', () => {
    const r = buildProduceRequest({ ...DEFAULT_DRAFT, key: '', value: 'x', valueFormat: 'string', partition: 2 });
    expect(typeof r !== 'string' && r.messages[0]).toMatchObject({ key: null, partition: 2 });
  });

  it('validates JSON, header keys, the repeat cap and schema subjects', () => {
    expect(buildProduceRequest({ ...DEFAULT_DRAFT, value: '{oops' })).toMatch(/not valid JSON/);
    expect(buildProduceRequest({ ...DEFAULT_DRAFT, value: '{}', headers: [{ key: ' ', value: 'v' }] })).toMatch(/header/);
    expect(buildProduceRequest({ ...DEFAULT_DRAFT, value: '{}', repeat: MAX_REPEAT + 1 })).toMatch(/Repeat/);
    expect(buildProduceRequest({ ...DEFAULT_DRAFT, value: '{}', valueFormat: 'avro' })).toMatch(/subject/);
    const avro = buildProduceRequest({ ...DEFAULT_DRAFT, value: '{}', valueFormat: 'avro', subject: 'payments-value', version: '2' });
    expect(typeof avro !== 'string' && avro.schema).toEqual({ subject: 'payments-value', version: 2 });
  });
});

describe('config lines', () => {
  it('parses name=value lines', () => {
    expect(parseConfigLines('# c\ncleanup.policy=compact\n\nretention.ms = 10')).toEqual({ configs: { 'cleanup.policy': 'compact', 'retention.ms': '10' }, error: null });
    expect(parseConfigLines('broken').error).toMatch(/Line 1/);
  });
});
