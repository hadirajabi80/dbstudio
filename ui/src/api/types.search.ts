// "Find in database" (engine: DbStudio.Core/Search). The UI opens a `db.search` stream:
//   POST /streams { kind: 'db.search', connectionId: 'engine', params: SearchRequestParams } → 202 { streamId }
// and receives SearchItem objects in `stream.data` batches; a `done` item ends a finished search, then
// `stream.state{ended, 'completed'}`. DELETE /streams/{id} cancels (no `done` item).
import type { CatalogObjectType, CellValue } from './types';

export const SEARCH_STREAM_KIND = 'db.search';

export interface SearchTargetParams {
  connectionId: string;
  database?: string | null;
  schema?: string | null;
  /** Chosen objects (their schemas come with them). */
  objects?: { schema: string | null; name: string; type: CatalogObjectType }[] | null;
}

export interface SearchRequestParams {
  term: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  in: { names: boolean; columns: boolean; code: boolean; data: boolean };
  /** Object types to search; null/empty = every type. */
  types: CatalogObjectType[] | null;
  targets: SearchTargetParams[];
  /** Rows read per table by a data search (1–1000). */
  dataRowLimit: number;
  maxHits?: number;
}

export type SearchMatchKind = 'name' | 'column' | 'code' | 'data';

export interface SearchHitItem {
  kind: 'hit';
  connectionId: string;
  database: string | null;
  schema: string | null;
  object: { name: string; type: CatalogObjectType };
  match: SearchMatchKind;
  /** The object name, column name, source line or a snippet of the cell value. */
  text: string;
  /** [start, length] of each match within `text`. */
  ranges: [number, number][];
  column: string | null;
  dataType: string | null;
  /** Code: 1-based line within the definition; null on a "more" summary. */
  line: number | null;
  /** Data: the row's primary key (null without one). */
  key: { column: string; value: CellValue }[] | null;
  /** Code: further matching lines of the object that were not sent (a summary hit has an empty text). */
  more: number;
}

export interface SearchProgressItem {
  kind: 'progress';
  connectionId: string;
  database: string | null;
  schema: string | null;
  phase: 'names' | 'columns' | 'code' | 'data';
  done: number;
  total: number;
  table: string | null;
}

export interface SearchErrorItem {
  kind: 'error';
  connectionId: string;
  database: string | null;
  schema: string | null;
  message: string;
  table: string | null;
  /** Informational (something was skipped on purpose), not a failure. */
  notice: boolean;
}

export interface SearchDoneItem {
  kind: 'done';
  hits: number;
  truncated: boolean;
  elapsedMs: number;
  connections: number;
}

export type SearchItem = SearchHitItem | SearchProgressItem | SearchErrorItem | SearchDoneItem;
