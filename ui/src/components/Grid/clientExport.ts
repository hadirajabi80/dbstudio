// Client-side export of grid rows to a file (Data tab, filtered/sorted console results): full values of truncated
// cells are fetched first (logic-12); SQL INSERT is refused while values are still truncated.
import { api } from '../../api/client';
import type { CellValue, ColumnInfo, Dialect } from '../../api/types';
import { serializeComplete, type CellFetcher, type CellLocator } from '../../lib/serialize';
import { getPlatform } from '../../platform';
import { toast } from '../../store/ui';

export type FileFormat = 'csv' | 'json' | 'sql-insert';

const EXT: Record<FileFormat, string> = { csv: 'csv', json: 'json', 'sql-insert': 'sql' };
const MIME: Record<FileFormat, string> = { csv: 'text/csv', json: 'application/json', 'sql-insert': 'application/sql' };

export const fetchCellFromEngine: CellFetcher = (l) => api.cell(l.executionId, l.resultSetId, l.row, l.col);

export async function exportRowsToFile(format: FileFormat, columns: ColumnInfo[], rows: CellValue[][], o: {
  baseName: string;
  dialect: Dialect;
  locate?: ((row: number, col: number) => CellLocator | null) | null;
  /** Extra line for the success toast ("Only the 1,000 loaded rows…"). */
  note?: string | null;
  /** Full-value fetcher (default: the engine's result store). */
  fetch?: CellFetcher | null;
}): Promise<void> {
  const out = await serializeComplete(format, columns, rows, { dialect: o.dialect, header: true, locate: o.locate, fetch: o.fetch ?? fetchCellFromEngine });
  if (!out.ok) {
    toast('warning', 'Cannot export as SQL INSERT', out.message);
    return;
  }
  const name = `${o.baseName.replace(/[^\w.-]+/g, '_') || 'result'}.${EXT[format]}`;
  const saved = await getPlatform().saveFile({ suggestedName: name, content: out.text, mime: MIME[format], filters: [{ name: format.toUpperCase(), extensions: [EXT[format]] }] });
  if (!saved) return;
  toast(out.warning ? 'warning' : 'success', `Exported ${rows.length} row${rows.length === 1 ? '' : 's'} to ${saved}`, [out.warning, o.note].filter(Boolean).join(' ') || undefined);
}
