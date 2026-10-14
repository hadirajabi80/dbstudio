// WP-H explain commands and the plan tab view. Auto-loaded by commands/index.ts.
// Ctrl+L / Ctrl+Shift+L are bound by the editor itself (Monaco actions, KeyMod.CtrlCmd → ⌘ on macOS); the registry
// lists them for the palette, menus and the shortcut sheet.
import { registerCommands, type Command } from '../../commands/registry';
import { registerTabView } from '../layout/tabViews';
import { activeBinding } from '../../editor/registry';
import { setEditorConfig } from '../../editor/config';
import { PlanTabView } from './PlanTab';
import { explainInTab, PLAN_VIEW } from './explain';

const hasEditor = () => !!activeBinding();

export const EXPLAIN_COMMANDS: Command[] = [
  {
    id: 'explain.estimated', title: 'Explain plan (estimated)', category: 'Query', shortcut: 'Ctrl+L', scope: 'editor', keyHandler: 'host',
    icon: 'ListTree', keywords: 'execution plan showplan explain', when: hasEditor,
    run: () => { const b = activeBinding(); if (b) void import('../../editor/actions').then((a) => a.runExplain(b.editor, b, 'estimated')); },
  },
  {
    id: 'explain.actual', title: 'Explain plan (actual, runs the statement)', category: 'Query', shortcut: 'Ctrl+Shift+L', scope: 'editor',
    keyHandler: 'host', icon: 'ListTree', keywords: 'execution plan statistics actual', when: hasEditor,
    run: () => { const b = activeBinding(); if (b) void import('../../editor/actions').then((a) => a.runExplain(b.editor, b, 'actual')); },
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
