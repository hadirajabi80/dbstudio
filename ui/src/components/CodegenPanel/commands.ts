// WP-I code generation commands (auto-loaded by commands/index.ts) and the codegen tab views.
//   codegen.open  (Ctrl+Alt+G)  explorer object(s) / active object or designer tab → "Generate code" tab
//   codegen.query               statement at the cursor of the active console (or args from a result set)
import type { ColumnInfo } from '../../api/types';
import { getEditor } from '../../app/editors';
import { registerCommands, type Command } from '../../commands/registry';
import { isObjectTarget } from '../../commands/types';
import { objectOf } from '../../designer/open';
import { getActiveConsole, getActiveTab } from '../../store/tabs';
import { toast } from '../../store/ui';
import { registerTabView } from '../layout/tabViews';
import { CODEGEN_FILE_VIEW, CODEGEN_VIEW, openCodegen } from './open';
import { CodegenTab, GeneratedFileTab } from './views';

/** Args a result-set toolbar ("Code ▾") can pass to codegen.query. */
export interface QueryCodegenArgs {
  connectionId: string;
  database: string | null;
  sql: string;
  columns?: ColumnInfo[] | null;
  name?: string;
}

const isQueryArgs = (a: unknown): a is QueryCodegenArgs => !!a && typeof a === 'object' && typeof (a as QueryCodegenArgs).sql === 'string' && typeof (a as QueryCodegenArgs).connectionId === 'string';

export const CODEGEN_COMMANDS: Command<never>[] = [
  {
    id: 'codegen.open', title: 'Generate code…', category: 'Database', shortcut: 'Mod+Alt+G', icon: 'Code2',
    keywords: 'c# csharp dapper ef core go golang typescript node java jdbc python dataclass sqlalchemy dto entity model repository',
    run: (args?: unknown) => {
      const t = objectOf(args);
      if (t) {
        const refs = isObjectTarget(args) && args.refs?.length ? args.refs : [t.ref];
        openCodegen(t.connectionId, t.database, refs.map((ref) => ({ kind: 'object', ref })));
        return;
      }
      const tab = getActiveTab();
      openCodegen(tab?.connectionId ?? null, tab?.connectionId ? tab.database : null, []);
    },
  },
  {
    id: 'codegen.query', title: 'Generate code for query', category: 'Query', icon: 'Code2', keywords: 'dto query parameters typed',
    when: (args?: unknown) => isQueryArgs(args) || !!getActiveConsole()?.connectionId,
    run: (args?: unknown) => {
      if (isQueryArgs(args)) {
        openCodegen(args.connectionId, args.database, [{ kind: 'query', name: args.name ?? 'Query', sql: args.sql, columns: args.columns ?? null }]);
        return;
      }
      const tab = getActiveConsole();
      if (!tab?.connectionId) return;
      const target = getEditor(tab.id)?.getRunTarget('statement');
      const sql = target?.batches.map((b) => b.sql).join('\n').trim();
      if (!sql) {
        toast('info', 'Put the cursor in a SELECT statement first');
        return;
      }
      openCodegen(tab.connectionId, tab.database, [{ kind: 'query', name: queryName(tab.title), sql, columns: null }]);
    },
  },
];

function queryName(title: string): string {
  const base = title.replace(/\.sql$/i, '').replace(/^Console\s*\d*$/i, '').replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return base ? base.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('') + 'Query' : 'Query';
}

let registered = false;

export function registerCodegenCommands(): void {
  if (registered) return;
  registered = true;
  registerTabView(CODEGEN_VIEW, { component: CodegenTab, icon: 'Code2' });
  registerTabView(CODEGEN_FILE_VIEW, { component: GeneratedFileTab, icon: 'FileCode2' });
  registerCommands(CODEGEN_COMMANDS);
}

export { CODEGEN_VIEW };
