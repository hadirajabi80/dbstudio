// Client-side Excel export (.xlsx, Office Open XML) of grid rows — filtered / sorted / edited grids that the engine's
// result store cannot export as shown. Same parts and cell rules as the engine's XlsxResultWriter
// (engine/src/DbStudio.Core/Export/XlsxResultWriter.cs): typed cells (numbers, booleans, dates as serials with a date
// format, text as inline strings), a bold frozen header with an auto filter, column widths from the first rows, and
// Excel's 1,048,576-row limit. The ZIP container is written here (CRC-32 + deflate-raw through CompressionStream,
// stored entries where that is unavailable) so no dependency is needed.
import type { CellValue, ColumnInfo } from '../../api/types';
import { base64ToHex, isBinary, isCursor, isTruncated } from '../../lib/format';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Excel's row limit (header included). */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;
/** Excel's limit for the text of one cell. */
export const XLSX_MAX_CELL_CHARS = 32_767;
const SAMPLE_ROWS = 200;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_DATETIME = 3;
const STYLE_TIME = 4;

// ---------------------------------------------------------------- values

/** Removes what XML 1.0 cannot carry (C0 controls except tab / LF / CR, lone surrogates, U+FFFE/U+FFFF) and caps the length. */
export function cleanText(s: string): string {
  let out = '';
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      } else changed = true;
      continue;
    }
    const ok = c >= 0xdc00 && c <= 0xdfff ? false : c >= 0x20 ? c !== 0xfffe && c !== 0xffff : c === 9 || c === 10 || c === 13;
    if (ok) out += s[i];
    else changed = true;
  }
  const r = changed ? out : s;
  return r.length > XLSX_MAX_CELL_CHARS ? r.slice(0, XLSX_MAX_CELL_CHARS) : r;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (s: string) => cleanText(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** 0 → "A", 25 → "Z", 26 → "AA". */
export function columnName(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A decimal text that an Excel number (IEEE double, 15 significant digits) holds without loss. */
export function exactNumber(s: string): boolean {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return false;
  let mantissa = s.split(/[eE]/)[0].replace('-', '').replace('.', '').replace(/^0+/, '');
  if (s.includes('.')) mantissa = mantissa.replace(/0+$/, '');
  return mantissa.length <= 15 && Number.isFinite(Number(s));
}

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 30);

/** Excel serial of a wire date / datetime ("2026-10-14", "2026-10-14T10:00:00.5"); null before 1900-01-01 or when invalid. */
export function dateSerial(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?)?$/.exec(s);
  if (!m) return null;
  const [y, mo, d, h = '0', mi = '0', se = '0'] = m.slice(1);
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d || +h > 23 || +mi > 59 || +se > 59) return null;
  if (+y < 1900) return null;
  let serial = (t - EPOCH) / DAY_MS + (m[7] ? Number(`0.${m[7]}`) / 86_400 : 0);
  // Excel's day 60 is the fictitious 1900-02-29: dates before March 1900 are one lower
  if (serial < 61) serial -= 1;
  return serial;
}

/** Fraction of a day of a wire time ("10:00:00.5"); null for anything else. */
export function timeFraction(s: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?$/.exec(s);
  if (!m || +m[1] > 23 || +m[2] > 59 || +m[3] > 59) return null;
  return (+m[1] * 3600 + +m[2] * 60 + +m[3] + (m[4] ? Number(`0.${m[4]}`) : 0)) / 86_400;
}

/** A valid sheet name (at most 31 chars, none of : \ / ? * [ ], no leading / trailing apostrophe). */
export function sheetName(name: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  let s = (name ?? '').replace(/[:\\/?*[\]\u0000-\u001f]/g, '').trim().replace(/^'+|'+$/g, '');
  if (s.length > 31) s = s.slice(0, 31);
  return !s || s.toLowerCase() === 'history' ? 'Result' : s;
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(15))));

/** Full text of a value for a text cell (binary as 0x-hex). */
function textOf(v: CellValue): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && isBinary(v)) return `0x${base64ToHex(v.$bin)}`;
  if (v && isTruncated(v)) return v.$trunc;
  return '';
}

function inlineStr(ref: string, text: string, style: number): string {
  const clean = cleanText(text);
  const preserve = clean.length > 0 && (/^\s|\s$/.test(clean) || clean.includes('\n')) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style ? ` s="${style}"` : ''} t="inlineStr"><is><t${preserve}>${esc(clean)}</t></is></c>`;
}

const numCell = (ref: string, value: string, style = 0) => `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;

/** One cell's XML (empty for NULL). */
export function cellXml(ref: string, v: CellValue, col: ColumnInfo): string {
  if (v === null || v === undefined || (typeof v === 'object' && isCursor(v))) return '';
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return inlineStr(ref, String(v), 0);
    // integers with more digits than an Excel number keeps stay text (IDs would lose their last digits)
    if (Number.isInteger(v) && Math.abs(v) >= 1e15) return inlineStr(ref, String(v), 0);
    return numCell(ref, num(v));
  }
  if (typeof v === 'string') {
    if ((col.kind === 'int' || col.kind === 'decimal' || col.kind === 'float') && exactNumber(v)) return numCell(ref, v);
    if (col.kind === 'date' || col.kind === 'datetime') {
      const serial = dateSerial(v);
      if (serial !== null) return numCell(ref, num(serial), col.kind === 'date' || !/[T ]/.test(v) ? STYLE_DATE : STYLE_DATETIME);
    }
    if (col.kind === 'time') {
      const f = timeFraction(v);
      if (f !== null) return numCell(ref, num(f), STYLE_TIME);
    }
  }
  return inlineStr(ref, textOf(v), 0);
}

/** Approximate width in Excel character units (wide East Asian characters count double). */
function displayLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1;
  }
  return n;
}

/** Column width in characters: header and the first rows (longest line), within 8..60; dates get room for their format. */
export function columnWidth(col: ColumnInfo, index: number, sample: readonly (readonly CellValue[])[]): number {
  let max = Math.max(4, displayLength(col.name) + 2);
  const floor = col.kind === 'date' ? 11 : col.kind === 'datetime' ? 20 : col.kind === 'time' ? 10 : 0;
  for (const row of sample) {
    const v = row[index];
    if (v === null || v === undefined) continue;
    for (const line of textOf(v).slice(0, 200).split('\n')) max = Math.max(max, displayLength(line));
  }
  return Math.min(60, Math.max(8, max + 1, floor));
}

// ---------------------------------------------------------------- parts

export interface XlsxOptions {
  /** Sheet name (default: the table of the first column with one, else "Result"). */
  sheetName?: string | null;
  /** Sheet row limit (header included); tests use a small one. */
  maxRows?: number;
}

export interface XlsxResult {
  bytes: Uint8Array;
  /** Data rows left out (Excel row limit). */
  dropped: number;
}

function sheetXml(columns: readonly ColumnInfo[], rows: readonly (readonly CellValue[])[], maxRows: number): { xml: string; filterRef: string | null; dropped: number } {
  const parts: string[] = [`${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`];
  parts.push('<sheetViews><sheetView workbookViewId="0">');
  if (columns.length) parts.push('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>');
  parts.push('</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>');
  const sample = rows.slice(0, SAMPLE_ROWS);
  if (columns.length) {
    parts.push('<cols>');
    columns.forEach((c, i) => parts.push(`<col min="${i + 1}" max="${i + 1}" width="${columnWidth(c, i, sample)}" customWidth="1"/>`));
    parts.push('</cols>');
  }
  parts.push('<sheetData>');
  const names = columns.map((_, i) => columnName(i));
  if (columns.length) {
    parts.push('<row r="1">');
    columns.forEach((c, i) => parts.push(inlineStr(`${names[i]}1`, c.name || `column${i + 1}`, STYLE_HEADER)));
    parts.push('</row>');
  }
  // the last sheet row is kept for the "row limit reached" note
  const fit = Math.max(0, Math.min(rows.length, maxRows - 2));
  for (let r = 0; r < fit; r++) {
    const rn = r + 2;
    let line = `<row r="${rn}">`;
    const row = rows[r];
    for (let i = 0; i < columns.length && i < row.length; i++) line += cellXml(`${names[i]}${rn}`, row[i], columns[i]);
    parts.push(line + '</row>');
  }
  const dropped = rows.length - fit;
  const lastRow = fit + 1;
  const filterRef = columns.length ? `A1:${names[columns.length - 1]}${lastRow}` : null;
  if (dropped > 0) {
    const rn = lastRow + 1;
    parts.push(`<row r="${rn}">${inlineStr(`A${rn}`, `Excel row limit reached: ${dropped.toLocaleString('en-US')} more row(s) were not exported. Export as CSV to get every row.`, 0)}</row>`);
  }
  parts.push('</sheetData>');
  if (filterRef) parts.push(`<autoFilter ref="${filterRef}"/>`);
  parts.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>');
  return { xml: parts.join(''), filterRef, dropped };
}

const CONTENT_TYPES =
  `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '</Types>';

const ROOT_RELS =
  `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '</Relationships>';

const APP_PROPS = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Rowlit</Application></Properties>`;

function coreProps(now: Date): string {
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>Rowlit</dc:creator>' +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${at}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${at}</dcterms:modified></cp:coreProperties>`;
}

const absRef = (range: string) => range.split(':').map((p) => p.replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2')).join(':');

function workbookXml(name: string, filterRef: string | null): string {
  const quoted = `'${name.replace(/'/g, "''")}'`;
  return `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews>` +
    `<sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    (filterRef ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${esc(`${quoted}!${absRef(filterRef)}`)}</definedName></definedNames>` : '') +
    '</workbook>';
}

const WORKBOOK_RELS =
  `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

/** cellXfs: 0 default, 1 bold header, 2 date, 3 date + time, 4 time. */
const STYLES =
  `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">` +
  '<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/><numFmt numFmtId="166" formatCode="hh:mm:ss"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/** The workbook of one sheet: header row from `columns`, then `rows`. */
export async function toXlsx(columns: readonly ColumnInfo[], rows: readonly (readonly CellValue[])[], opts: XlsxOptions = {}): Promise<XlsxResult> {
  const cols = columns.slice(0, XLSX_MAX_COLUMNS);
  const sheet = sheetXml(cols, rows, Math.max(3, opts.maxRows ?? XLSX_MAX_ROWS));
  const name = sheetName(opts.sheetName ?? cols.find((c) => c.table)?.table);
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['docProps/app.xml', APP_PROPS],
    ['docProps/core.xml', coreProps(new Date())],
    ['xl/workbook.xml', workbookXml(name, sheet.filterRef)],
    ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
    ['xl/styles.xml', STYLES],
    ['xl/worksheets/sheet1.xml', sheet.xml],
  ].map(([n, x]) => ({ name: n, data: enc.encode(x) }));
  return { bytes: await zip(entries), dropped: sheet.dropped };
}

// ---------------------------------------------------------------- ZIP

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

let CRC_TABLE: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Raw DEFLATE through the platform's CompressionStream; null where it is missing (the entry is then stored). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined' || data.length < 256) return null;
  try {
    const body = new Response(data as BodyInit).body;
    if (!body) return null;
    const stream = body.pipeThrough(new CompressionStream('deflate-raw' as CompressionFormat));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A ZIP archive (deflated where that helps, UTF-8 names, no ZIP64: the parts stay far below 4 GB). */
export async function zip(entries: readonly ZipEntry[], now = new Date()): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const deflated = await deflateRaw(e.data);
    const useDeflate = !!deflated && deflated.length < e.data.length;
    const body = useDeflate ? deflated! : e.data;
    const method = useDeflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    chunks.push(local, body);
    central.push(cd);
    offset += local.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
