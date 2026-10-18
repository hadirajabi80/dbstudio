// WP-H explain commands and the plan tab view. Auto-loaded by commands/index.ts.
// Ctrl+L / Ctrl+Shift+L are console-scoped registry commands: they work wherever focus is inside the console (editor,
// toolbar, results grid) and act on that console's editor. Monaco also binds them (KeyMod.CtrlCmd → ⌘ on macOS),
// but the global dispatcher handles the key first in the capture phase, so a key press never runs twice.
import { registerCommands, type Command } from '../../commands/registry';
import type { ExplainMode } from '../../api/types';
import { getEditor } from '../../app/editors';
import { activeBinding } from '../../editor/registry';
import { setEditorConfig } from '../../editor/config';
import { getActiveConsole } from '../../store/tabs';
import { toast } from '../../store/ui';
import { registerTabView } from '../layout/tabViews';
import { PlanTabView } from './PlanTab';
import { explainInTab, PLAN_VIEW } from './explain';

const hasConsoleEditor = () => {
  const t = getActiveConsole();
  return !!t && (!!getEditor(t.id)?.explain || activeBinding()?.tabId === t.id);
};

function explainActive(mode: ExplainMode): void {
  const t = getActiveConsole();
  if (!t) return;
  const h = getEditor(t.id);
  if (h?.explain) {
    if (!h.explain(mode)) toast('info', 'Put the cursor in a statement to explain it');
    return;
  }
  const b = activeBinding();
  if (b?.tabId === t.id) void import('../../editor/actions').then((a) => a.runExplain(b.editor, b, mode));
}

export const EXPLAIN_COMMANDS: Command[] = [
  {
    id: 'explain.estimated', title: 'Explain plan (estimated)', category: 'Query', shortcut: 'Mod+L', scope: 'console',
    icon: 'ListTree', keywords: 'execution plan showplan explain', when: hasConsoleEditor,
    run: () => explainActive('estimated'),
  },
  {
    id: 'explain.actual', title: 'Explain plan (actual, runs the statement)', category: 'Query', shortcut: 'Mod+Shift+L', scope: 'console',
    icon: 'Gauge', keywords: 'execution plan statistics actual', when: hasConsoleEditor,
    run: () => explainActive('actual'),
  },
];

let registered = false;

export function registerPlanCommands(): void {
  if (registered) return;
  registered = true;
  registerTabView(PLAN_VIEW, { component: PlanTabView, icon: 'ListTree' });
  setEditorConfig({ explain: (t) => void explainInTab(t) });
  registerCommands(EXPLAIN_COMMANDS as Command<never>[]);
}
