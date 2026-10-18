// WP-H editor commands (formatter, snippets) for the command registry, and the settings → editor config sync.
// Auto-loaded by commands/index.ts.
//
// Format SQL (Shift+Alt+F, or the JetBrains Ctrl+Alt+L) and Insert snippet (Ctrl+J) are console-scoped registry
// commands: they work wherever focus is inside a console (editor, toolbar, results) and act on that console's
// editor. Monaco binds the same keys for
// editors outside consoles (designer previews); inside a console the global dispatcher handles the key first (capture
// phase), so it never runs twice. Format selection (a Ctrl+K chord) and the tab-focus toggle stay with Monaco
// (`keyHandler: 'host'`).
//
// Commands: format.document, format.selection, snippet.insert, snippets.manage, editor.toggleTabFocus.
// Explain commands live in components/PlanView/commands.ts.
import { registerCommands, type Command } from '../commands/registry';
import { FORMAT_ALT_SHORTCUT, isMac } from '../commands/keys';
import { getEditor } from '../app/editors';
import { useSettings } from '../store/settings';
import { getActiveConsole, useTabs } from '../store/tabs';
import { activeBinding } from './registry';
import { getEditorConfig, setEditorConfig } from './config';
import { openSnippetsSettings, registerSnippetsView } from '../components/SnippetsSettings/open';

// Monaco-dependent code is loaded on first use, so registering the commands never pulls Monaco in.
type Actions = typeof import('./actions');
type Binding = NonNullable<ReturnType<typeof activeBinding>>;

/** The console whose editor a command should act on: focus inside a console wins, else the active console. */
function consoleInFocus(): string | null {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  const el = a instanceof Element ? a.closest<HTMLElement>('.console[data-tab]') : null;
  if (el?.dataset.tab) return el.dataset.tab;
  const b = activeBinding();
  // Focus is in another editor (designer preview, codegen): act on that one.
  if (b && b.editor.hasTextFocus() && !b.tabId) return null;
  return getActiveConsole()?.id ?? null;
}

const writable = () => {
  const id = consoleInFocus();
  if (id && getEditor(id)) return true;
  const b = activeBinding();
  return !!b && !b.editor.getRawOptions().readOnly;
};

function withEditor(handle: (h: NonNullable<ReturnType<typeof getEditor>>) => boolean, fn: (a: Actions, b: Binding) => void) {
  return () => {
    const id = consoleInFocus();
    const h = id ? getEditor(id) : undefined;
    if (h && handle(h)) return;
    const b = activeBinding();
    if (b) void import('./actions').then((a) => fn(a, b));
  };
}

export const EDITOR_COMMANDS: Command[] = [
  {
    // Ctrl+Alt+L (⌘⌥L) is the DataGrip / JetBrains "Reformat code" key (user-01), advertised next to Shift+Alt+F.
    id: 'format.document', title: 'Format SQL', category: 'Edit', shortcut: 'Shift+Alt+F', altShortcuts: [FORMAT_ALT_SHORTCUT],
    showAltShortcuts: true, scope: 'console',
    icon: 'WandSparkles', keywords: 'beautify pretty print format document reformat code', when: writable,
    run: withEditor(
      (h) => (h.formatDocument ? (h.formatDocument(), h.focus(), true) : false),
      (a, b) => { a.formatDocument(b.editor, b.dialect ?? b.intel.dialect, b.formatOptions?.() ?? getEditorConfig().format); },
    ),
  },
  {
    id: 'format.selection', title: 'Format selection', category: 'Edit', shortcut: 'Mod+K Mod+F', scope: 'editor', keyHandler: 'host',
    icon: 'WandSparkles', keywords: 'beautify statement format', when: writable,
    run: withEditor(
      (h) => (h.formatSelection ? (h.formatSelection(), h.focus(), true) : false),
      (a, b) => { a.formatSelection(b.editor, b.dialect ?? b.intel.dialect, b.formatOptions?.() ?? getEditorConfig().format); },
    ),
  },
  {
    id: 'snippet.insert', title: 'Insert snippet…', category: 'Edit', shortcut: 'Mod+J', scope: 'console',
    icon: 'Braces', keywords: 'template live template snippet', when: writable,
    run: withEditor(
      (h) => (h.openSnippetPicker ? (h.focus(), h.openSnippetPicker(), true) : false),
      (a, b) => a.openSnippetPicker(b.editor, b),
    ),
  },
  {
    id: 'snippets.manage', title: 'Manage snippets…', category: 'Preferences', icon: 'Braces', keywords: 'snippets templates settings',
    run: () => openSnippetsSettings(),
  },
  {
    // Monaco's own binding (Ctrl+M; ⌃⇧M on macOS): Tab moves focus out of the editor instead of indenting.
    id: 'editor.toggleTabFocus', title: 'Toggle Tab key moves focus', category: 'Edit',
    shortcut: isMac() ? 'MacCtrl+Shift+M' : 'MacCtrl+M', scope: 'editor', keyHandler: 'host',
    icon: 'Keyboard', keywords: 'tab focus mode accessibility trap keyboard', when: () => !!activeBinding(),
    run: () => {
      const b = activeBinding();
      if (!b) return;
      b.editor.focus();
      b.editor.trigger('keyboard', 'editor.action.toggleTabFocusMode', null);
    },
  },
];

let quickFixes = false;

/**
 * "Did you mean …?" quick fixes (lightbulb) for unknown-table / unknown-column markers, the same suggestion the
 * Messages pane offers for the error. Registered lazily with the first console, so Monaco is not loaded by the
 * Welcome screen; never under unit tests (no Monaco there).
 */
function registerQuickFixes(): void {
  if (quickFixes || typeof window === 'undefined' || import.meta.env?.MODE === 'test') return;
  quickFixes = true;
  void Promise.all([import('./monaco'), import('./monaco-setup'), import('./registry'), import('./markers-core'), import('../components/MessagesPane/errorHelp')])
    .then(([monaco, setup, reg, core, help]) => {
      for (const id of Object.values(setup.LANGUAGE_IDS)) {
        monaco.languages.registerCodeActionProvider(id, {
          provideCodeActions(model, _range, context) {
            const b = reg.bindingFor(model);
            const none = { actions: [], dispose() {} };
            if (!b) return none;
            const cid = b.connectionId();
            if (!cid) return none;
            const markers = context.markers.map((m) => ({ ...m, code: typeof m.code === 'string' ? m.code : m.code?.value }));
            const sql = model.getValue();
            const fixes = core.didYouMeanFixes(markers, (m) => model.getValueInRange(m), (kind) => help.catalogNames(cid, kind, sql));
            return {
              actions: fixes.map((f) => ({
                title: f.title, kind: 'quickfix', isPreferred: true,
                diagnostics: context.markers.filter((m) => m.startLineNumber === f.range.startLineNumber && m.startColumn === f.range.startColumn),
                edit: { edits: [{ resource: model.uri, textEdit: { range: f.range, text: f.text }, versionId: model.getVersionId() }] },
              })),
              dispose() {},
            };
          },
        });
      }
    })
    .catch(() => { quickFixes = false; });
}

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
  const hasConsole = () => useTabs.getState().tabs.some((t) => t.kind === 'console');
  if (hasConsole()) registerQuickFixes();
  const unsubTabs = useTabs.subscribe(() => { if (!quickFixes && hasConsole()) registerQuickFixes(); });
  return () => { unsub(); unsubTabs(); off(); registered = false; };
}
