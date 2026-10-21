// Client-side export of grid rows to a file (Data tab, filtered/sorted console results): full values of truncated
// cells are fetched first (logic-12); SQL INSERT is refused while values are still truncated.
import { api } from '../../api/client';
import type { CellValue, ColumnInfo, Dialect } from '../../api/types';
import { resolvePartialValues, serializeComplete, truncationWarning, type CellFetcher, type CellLocator } from '../../lib/serialize';
import { getPlatform } from '../../platform';
import { toast } from '../../store/ui';
// the writer is loaded on first use (kept out of the initial bundle)
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export type FileFormat = 'csv' | 'json' | 'sql-insert' | 'xlsx';

export const FILE_EXT: Record<FileFormat, string> = { csv: 'csv', json: 'json', 'sql-insert': 'sql', xlsx: 'xlsx' };
export const FILE_MIME: Record<FileFormat, string> = { csv: 'text/csv', json: 'application/json', 'sql-insert': 'application/sql', xlsx: XLSX_MIME };
const FILTER_NAME: Record<FileFormat, string> = { csv: 'CSV', json: 'JSON', 'sql-insert': 'SQL', xlsx: 'Excel workbook' };

export const fetchCellFromEngine: CellFetcher = (l) => api.cell(l.executionId, l.resultSetId, l.row, l.col);

/** The rows as an Excel workbook (full values fetched first); `warning` names values that stayed truncated. */
export async function rowsToXlsx(columns: ColumnInfo[], rows: CellValue[][], o: {
  locate?: ((row: number, col: number) => CellLocator | null) | null;
  fetch?: CellFetcher | null;
  sheetName?: string | null;
}): Promise<{ blob: Blob; warning: string | null }> {
  const r = await resolvePartialValues(rows, { locate: o.locate, fetch: o.fetch ?? fetchCellFromEngine });
  const { toXlsx } = await import('./xlsx');
  const x = await toXlsx(columns, r.rows, { sheetName: o.sheetName });
  const warnings = [
    r.unresolved > 0 ? truncationWarning(r.unresolved) : null,
    x.dropped > 0 ? `${x.dropped.toLocaleString('en-US')} rows exceed Excel's row limit and were left out.` : null,
  ].filter(Boolean);
  return { blob: new Blob([x.bytes as BlobPart], { type: XLSX_MIME }), warning: warnings.length ? warnings.join(' ') : null };
}

export async function exportRowsToFile(format: FileFormat, columns: ColumnInfo[], rows: CellValue[][], o: {
  baseName: string;
  dialect: Dialect;
  locate?: ((row: number, col: number) => CellLocator | null) | null;
  /** Extra line for the success toast ("Only the 1,000 loaded rows…"). */
  note?: string | null;
  /** Full-value fetcher (default: the engine's result store). */
  fetch?: CellFetcher | null;
}): Promise<void> {
  let content: Blob | string;
  let warning: string | null;
  if (format === 'xlsx') {
    const x = await rowsToXlsx(columns, rows, { locate: o.locate, fetch: o.fetch, sheetName: o.baseName });
    content = x.blob;
    warning = x.warning;
  } else {
    const out = await serializeComplete(format, columns, rows, { dialect: o.dialect, header: true, locate: o.locate, fetch: o.fetch ?? fetchCellFromEngine });
    if (!out.ok) {
      toast('warning', 'Cannot export as SQL INSERT', out.message);
      return;
    }
    content = out.text;
    warning = out.warning;
  }
  // letters of any script stay (a Persian table name gives a Persian file name)
  const name = `${o.baseName.replace(/[^\p{L}\p{N}_.-]+/gu, '_') || 'result'}.${FILE_EXT[format]}`;
  const saved = await getPlatform().saveFile({ suggestedName: name, content, mime: FILE_MIME[format], filters: [{ name: FILTER_NAME[format], extensions: [FILE_EXT[format]] }] });
  if (!saved) return;
  toast(warning ? 'warning' : 'success', `Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${saved}`, [warning, o.note].filter(Boolean).join(' ') || undefined);
}
