// WP-G: query parameters (PLAN-M1.5 A2). Auto-loaded by commands/index.ts.
import { registerCommands, type Command } from '../../commands/registry';
import { getEditor } from '../../app/editors';
import { useTabs } from '../../store/tabs';
import { toast } from '../../store/ui';
import { runWithParamsIfNeeded } from './run';

function activeConsoleId(): string | null {
  const s = useTabs.getState();
  const t = s.tabs.find((x) => x.id === s.activeId);
  return t?.kind === 'console' && t.connectionId ? t.id : null;
}

export const PARAMS_COMMANDS: Command<never>[] = [
  {
    id: 'params.edit', title: 'Query parameters…', category: 'Query', shortcut: 'Mod+Alt+P', icon: 'Braces', keywords: 'bind variables @ : ?',
    when: () => !!activeConsoleId(),
    run: async () => {
      const tabId = activeConsoleId();
      if (!tabId) return;
      const target = getEditor(tabId)?.getRunTarget('statement');
      if (!target) {
        toast('info', 'Put the cursor in a statement with parameters');
        return;
      }
      const handled = await runWithParamsIfNeeded(tabId, 'statement', target.batches, true);
      if (!handled) toast('info', 'This statement has no parameters', 'Use @name (SQL Server), :name (Oracle/SQLite) or ? placeholders.');
    },
  },
];

export function registerParamsCommands(): void {
  registerCommands(PARAMS_COMMANDS);
}
