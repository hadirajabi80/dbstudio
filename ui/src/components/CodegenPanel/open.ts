// Opening "Generate code" tabs (a `view` tab registered as 'codegen').
import type { ColumnInfo, ObjectRef } from '../../api/types';
import type { QueryParamType } from '../../codegen';
import { qualifiedName } from '../../lib/sql';
import { dialectOf } from '../../store/connections';
import { useTabs } from '../../store/tabs';

export const CODEGEN_VIEW = 'codegen';
export const CODEGEN_FILE_VIEW = 'codegen.file';

export type CodegenTarget =
  | { kind: 'object'; ref: ObjectRef }
  | { kind: 'query'; name: string; sql: string; columns: ColumnInfo[] | null; paramTypes?: Record<string, QueryParamType> };

export interface CodegenTabState {
  connectionId: string | null;
  database: string | null;
  targets: CodegenTarget[];
  /** Result columns inferred by running a procedure ("Run to infer result columns"), by qualified routine name. */
  inferred?: Record<string, ColumnInfo[]>;
}

export interface CodegenFileState {
  path: string;
  language: string;
  content: string;
}

function labelOf(connectionId: string | null, t: CodegenTarget): string {
  if (t.kind === 'query') return t.name;
  return connectionId ? qualifiedName(t.ref, dialectOf(connectionId), { always: dialectOf(connectionId) !== 'sqlite' }) : t.ref.name;
}

export function openCodegen(connectionId: string | null, database: string | null, targets: CodegenTarget[]): string {
  const labels = targets.map((t) => labelOf(connectionId, t));
  const title = targets.length ? `Code: ${labels.slice(0, 2).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}` : 'Generate code';
  const key = targets.length && targets.every((t) => t.kind === 'object') ? `${connectionId}|${database ?? ''}|${labels.join(',')}` : null;
  return useTabs.getState().openView({
    view: CODEGEN_VIEW,
    title,
    connectionId,
    database,
    state: { connectionId, database, targets } satisfies CodegenTabState,
    key,
  });
}

export function openGeneratedFile(file: CodegenFileState): string {
  return useTabs.getState().openView({ view: CODEGEN_FILE_VIEW, title: file.path, state: file });
}
