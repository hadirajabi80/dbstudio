// The client-side .xlsx writer: the ZIP is read back with node:zlib and every part parsed as XML.
import { describe, expect, it } from 'vitest';
import type { CellValue, ColumnInfo, ColumnKind } from '../../api/types';
import { cleanText, columnName, crc32, dateSerial, exactNumber, sheetName, timeFraction, toXlsx, XLSX_MAX_CELL_CHARS, zip } from './xlsx';

// node:zlib without @types/node in the UI project (same pattern as codegen/__tests__/correctness.test.ts)
const load = (id: string) => import(/* @vite-ignore */ id) as Promise<unknown>;
const zlib = (await load('node:zlib')) as { inflateRawSync(b: Uint8Array): Uint8Array };
const { inflateRawSync } = zlib;

const col = (name: string, kind: ColumnKind, table: string | null = null): ColumnInfo => ({
  name, ordinal: 0, dbType: kind, kind, nullable: true, size: null, precision: null, scale: null, table, schema: null, isKey: false,
});

/** Minimal ZIP reader (central directory → local entries), enough to check what the writer produced. */
function unzip(bytes: Uint8Array): Map<string, string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(dv.getUint32(p, true)).toBe(0x02014b50);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    expect(dv.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + csize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, dec.decode(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
}

function cell(sheet: Document, ref: string): Element | undefined {
  return [...sheet.getElementsByTagNameNS(NS, 'c')].find((c) => c.getAttribute('r') === ref);
}

const text = (c: Element | undefined) => c?.getElementsByTagNameNS(NS, 't')[0]?.textContent ?? c?.getElementsByTagNameNS(NS, 'v')[0]?.textContent ?? null;

async function build(columns: ColumnInfo[], rows: CellValue[][], maxRows?: number) {
  const x = await toXlsx(columns, rows, { maxRows });
  const parts = unzip(x.bytes);
  return { x, parts, sheet: parse(parts.get('xl/worksheets/sheet1.xml')!) };
}

const COLUMNS = [
  col('id', 'int', 'سفارش'), col('name', 'string'), col('total', 'decimal'), col('paid', 'bool'), col('on', 'date'),
  col('at', 'datetime'), col('t', 'time'), col('data', 'binary'), col('ratio', 'float'),
];

describe('client-side xlsx export', () => {
  it('writes every OpenXML part as well-formed XML, with the sheet named after the table', async () => {
    const { parts } = await build(COLUMNS, [[1, 'a', '1.5', true, null, null, null, null, 0.5]]);
    expect([...parts.keys()].sort()).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
    ]);
    for (const xml of parts.values()) parse(xml);
    const wb = parse(parts.get('xl/workbook.xml')!);
    expect(wb.getElementsByTagNameNS(NS, 'sheet')[0].getAttribute('name')).toBe('سفارش');
    expect(wb.getElementsByTagNameNS(NS, 'definedName')[0].textContent).toBe("'سفارش'!$A$1:$I$2");
  });

  it('types cells: numbers, exact decimals, booleans, date / datetime / time serials, text', async () => {
    const { sheet } = await build(COLUMNS, [
      [42, 'Ali', '12.50', true, '2026-10-14', '2026-10-14T12:00:00', '06:00:00', { $bin: 'qwE=', len: 2 }, 0.25],
      [9007199254740991, null, '12345678901234567890.12', false, '1899-01-01', '2026-10-14T12:00:00.5', '25:00:00', null, 'NaN'],
    ]);
    expect(cell(sheet, 'A2')!.getAttribute('t')).toBeNull();
    expect(text(cell(sheet, 'A2'))).toBe('42');
    expect(cell(sheet, 'B2')!.getAttribute('t')).toBe('inlineStr');
    expect(text(cell(sheet, 'C2'))).toBe('12.50');
    expect(cell(sheet, 'C2')!.getAttribute('t')).toBeNull();
    expect([cell(sheet, 'D2')!.getAttribute('t'), text(cell(sheet, 'D2'))]).toEqual(['b', '1']);
    expect([text(cell(sheet, 'E2')), cell(sheet, 'E2')!.getAttribute('s')]).toEqual(['46309', '2']);
    expect([text(cell(sheet, 'F2')), cell(sheet, 'F2')!.getAttribute('s')]).toEqual(['46309.5', '3']);
    expect([text(cell(sheet, 'G2')), cell(sheet, 'G2')!.getAttribute('s')]).toEqual(['0.25', '4']);
    expect(text(cell(sheet, 'H2'))).toBe('0xAB01');
    expect(text(cell(sheet, 'I2'))).toBe('0.25');

    expect(cell(sheet, 'A3')!.getAttribute('t')).toBe('inlineStr'); // 16 digits: text keeps every digit
    expect(text(cell(sheet, 'A3'))).toBe('9007199254740991');
    expect(cell(sheet, 'B3')).toBeUndefined(); // NULL → no cell
    expect(text(cell(sheet, 'C3'))).toBe('12345678901234567890.12');
    expect(cell(sheet, 'C3')!.getAttribute('t')).toBe('inlineStr');
    expect(text(cell(sheet, 'E3'))).toBe('1899-01-01');
    expect(Number(text(cell(sheet, 'F3')))).toBeCloseTo(46309.5 + 0.5 / 86400, 9);
    expect(text(cell(sheet, 'G3'))).toBe('25:00:00');
    expect(text(cell(sheet, 'I3'))).toBe('NaN');
  });

  it('header: bold style, frozen pane, auto filter, column widths', async () => {
    const { sheet, parts } = await build(COLUMNS, [[1, 'x'.repeat(30), '1', true, null, null, null, null, 1]]);
    const header = sheet.getElementsByTagNameNS(NS, 'row')[0];
    for (const c of header.getElementsByTagNameNS(NS, 'c')) expect(c.getAttribute('s')).toBe('1');
    const pane = sheet.getElementsByTagNameNS(NS, 'pane')[0];
    expect([pane.getAttribute('state'), pane.getAttribute('ySplit'), pane.getAttribute('topLeftCell')]).toEqual(['frozen', '1', 'A2']);
    expect(sheet.getElementsByTagNameNS(NS, 'autoFilter')[0].getAttribute('ref')).toBe('A1:I2');
    const widths = [...sheet.getElementsByTagNameNS(NS, 'col')].map((c) => Number(c.getAttribute('width')));
    expect(widths).toHaveLength(COLUMNS.length);
    expect(widths[1]).toBeGreaterThan(30);
    expect(widths[0]).toBe(8);
    expect(widths[5]).toBe(20); // datetime room
    const order = [...sheet.documentElement.children].map((e) => e.localName);
    expect(order.indexOf('sheetViews')).toBeLessThan(order.indexOf('cols'));
    expect(order.indexOf('cols')).toBeLessThan(order.indexOf('sheetData'));
    expect(order.indexOf('sheetData')).toBeLessThan(order.indexOf('autoFilter'));
    const styles = parse(parts.get('xl/styles.xml')!);
    expect(styles.getElementsByTagNameNS(NS, 'font')[1].getElementsByTagNameNS(NS, 'b')).toHaveLength(1);
  });

  it('escapes markup, strips control characters, keeps Unicode / RTL text and caps long cells', async () => {
    const { sheet } = await build([col('نام <&>', 'string')], [
      ['a<b>&"c"\''], ['bell\u0007 nul\u0000 tab\tline\nend'], ['سلام دنیا ✓ 😀'], ['  padded  '], ['lone \ud800 surrogate'],
      ['z'.repeat(40_000)], [{ $trunc: 'full text of a long value', len: 99 }],
    ]);
    expect(text(cell(sheet, 'A1'))).toBe('نام <&>');
    expect(text(cell(sheet, 'A2'))).toBe('a<b>&"c"\'');
    expect(text(cell(sheet, 'A3'))).toBe('bell nul tab\tline\nend');
    expect(cell(sheet, 'A3')!.getElementsByTagNameNS(NS, 't')[0].getAttribute('xml:space')).toBe('preserve');
    expect(text(cell(sheet, 'A4'))).toBe('سلام دنیا ✓ 😀');
    expect(text(cell(sheet, 'A5'))).toBe('  padded  ');
    expect(text(cell(sheet, 'A6'))).toBe('lone  surrogate');
    expect(text(cell(sheet, 'A7'))).toHaveLength(XLSX_MAX_CELL_CHARS);
    expect(text(cell(sheet, 'A8'))).toBe('full text of a long value');
  });

  it("stops at Excel's row limit and leaves a note on the last row", async () => {
    const rows = Array.from({ length: 400 }, (_, i) => [i + 1] as CellValue[]);
    const { x, sheet } = await build([col('n', 'int')], rows, 10);
    expect(x.dropped).toBe(392);
    expect(sheet.getElementsByTagNameNS(NS, 'row')).toHaveLength(10);
    expect(text(cell(sheet, 'A9'))).toBe('8');
    expect(text(cell(sheet, 'A10'))).toMatch(/^Excel row limit reached: 392 more row\(s\)/);
  });

  it('an empty result still makes a valid workbook', async () => {
    const { sheet } = await build(COLUMNS, []);
    expect(sheet.getElementsByTagNameNS(NS, 'row')).toHaveLength(1);
  });

  it('zip: stored and deflated entries round-trip with correct CRCs', async () => {
    const big = new TextEncoder().encode('<row>'.repeat(2000));
    const bytes = await zip([{ name: 'a.txt', data: new TextEncoder().encode('hi') }, { name: 'dir/ü.xml', data: big }]);
    const parts = unzip(bytes);
    expect(parts.get('a.txt')).toBe('hi');
    // the big entry is deflated where CompressionStream exists (browsers, Electron, Node)
    if (typeof CompressionStream !== 'undefined') expect(bytes.length).toBeLessThan(big.length / 4);
    expect(parts.get('dir/ü.xml')).toHaveLength(big.length);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('xlsx value helpers', () => {
  it('column names', () => {
    expect([0, 25, 26, 701, 702, 16383].map(columnName)).toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA', 'XFD']);
  });
  it('date serials follow Excel (1900 leap-year quirk) and reject pre-1900 / invalid dates', () => {
    expect(dateSerial('1900-01-01')).toBe(1);
    expect(dateSerial('1900-02-28')).toBe(59);
    expect(dateSerial('1900-03-01')).toBe(61);
    expect(dateSerial('2026-10-14T18:00:00')).toBe(46309.75);
    expect(dateSerial('1899-12-31')).toBeNull();
    expect(dateSerial('2026-02-30')).toBeNull();
    expect(dateSerial('2026-10-14T10:00:00+02:00')).toBeNull(); // offsets stay text
    expect(timeFraction('12:00:00')).toBe(0.5);
    expect(timeFraction('24:00:00')).toBeNull();
  });
  it('exact numbers', () => {
    expect(['12.50', '-0.001', '123456789012345'].map(exactNumber)).toEqual([true, true, true]);
    expect(['1234567890123456', '1e400', '12a', '007', ''].map(exactNumber)).toEqual([false, false, false, false, false]);
  });
  it('sheet names and cleaning', () => {
    expect(sheetName('a/b\\c?d*e[f]g:h')).toBe('abcdefgh');
    expect(sheetName('')).toBe('Result');
    expect(sheetName('History')).toBe('Result');
    expect(sheetName('n'.repeat(50))).toHaveLength(31);
    expect(cleanText('ok\u0001￿')).toBe('ok');
  });
});
