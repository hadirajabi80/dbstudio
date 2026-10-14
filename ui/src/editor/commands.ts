// WP-H editor commands (formatter, snippets) for the command registry, and the settings → editor config sync.
// Auto-loaded by commands/index.ts. The keys are bound by the editor itself (Monaco actions with KeyMod.CtrlCmd, so
// ⌘ on macOS): the registry entries are `keyHandler: 'host'` and serve the palette, menus and the shortcut sheet.
//
// Commands: format.document (Shift+Alt+F), format.selection (Ctrl+K Ctrl+F), snippet.insert (Ctrl+J),
// snippets.manage (opens Settings → Snippets as a tab). Explain commands live in components/PlanView/commands.ts.
import { registerCommands, type Command } from '../commands/registry';
import { useSettings } from '../store/settings';
import { activeBinding } from './registry';
import { getEditorConfig, setEditorConfig } from './config';
import { openSnippetsSettings, registerSnippetsView } from '../components/SnippetsSettings/open';

// Monaco-dependent code is loaded on first use, so registering the commands never pulls Monaco in.
type Actions = typeof import('./actions');
type Binding = NonNullable<ReturnType<typeof activeBinding>>;

const writable = () => {
  const b = activeBinding();
  return !!b && !b.editor.getRawOptions().readOnly;
};

function withEditor(fn: (a: Actions, b: Binding) => void) {
  return () => {
    const b = activeBinding();
    if (b) void import('./actions').then((a) => fn(a, b));
  };
}

export const EDITOR_COMMANDS: Command[] = [
  {
    id: 'format.document', title: 'Format SQL', category: 'Edit', shortcut: 'Shift+Alt+F', scope: 'editor', keyHandler: 'host',
    icon: 'WandSparkles', keywords: 'beautify pretty print format document', when: writable,
    run: withEditor((a, b) => { a.formatDocument(b.editor, b.dialect ?? b.intel.dialect, b.formatOptions?.() ?? getEditorConfig().format); }),
  },
  {
    id: 'format.selection', title: 'Format selection', category: 'Edit', shortcut: 'Ctrl+K Ctrl+F', scope: 'editor', keyHandler: 'host',
    icon: 'WandSparkles', keywords: 'beautify statement format', when: writable,
    run: withEditor((a, b) => { a.formatSelection(b.editor, b.dialect ?? b.intel.dialect, b.formatOptions?.() ?? getEditorConfig().format); }),
  },
  {
    id: 'snippet.insert', title: 'Insert snippet…', category: 'Edit', shortcut: 'Ctrl+J', scope: 'editor', keyHandler: 'host',
    icon: 'Braces', keywords: 'template live template snippet', when: writable,
    run: withEditor((a, b) => a.openSnippetPicker(b.editor, b)),
  },
  {
    id: 'snippets.manage', title: 'Manage snippets…', category: 'Preferences', icon: 'Braces', keywords: 'snippets templates settings',
    run: () => openSnippetsSettings(),
  },
];

let registered = false;

/** Registers the commands and keeps the editor config in sync with Settings.format / Settings.snippets. */
export function registerEditorCommands(): () => void {
  if (registered) return () => {};
  registered = true;
  const sync = () => {
    const s = useSettings.getState().settings as { format?: unknown; snippets?: unknown };
    setEditorConfig({
      format: (s.format ?? null) as ReturnType<typeof getEditorConfig>['format'],
      snippets: Array.isArray(s.snippets) ? s.snippets : [],
    });
  };
  sync();
  registerSnippetsView();
  const unsub = useSettings.subscribe(sync);
  const off = registerCommands(EDITOR_COMMANDS as Command<never>[]);
  return () => { unsub(); off(); registered = false; };
}
