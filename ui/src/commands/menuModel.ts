// Menu, toolbar and context-menu models as pure data (no imports): the Electron main process builds the native
// menu from MENUS (desktop/src/main/menu.ts), the renderer builds context menus/toolbars from the same ids, and
// commands.coverage.test.ts checks that every id is a registered command with the same title and shortcut.
//
// `optional: true` marks commands registered by other packages (WP-G/H/I); the shell hides an optional item whose
// command is not registered, and the coverage test requires them once their package's commands.ts exists.

export type NativeRole =
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll' | 'quit' | 'togglefullscreen' | 'reload'
  | 'toggleDevTools' | 'minimize' | 'zoom' | 'front' | 'close' | 'about' | 'hide' | 'hideOthers' | 'unhide' | 'services';

export interface MenuCommandItem {
  type?: 'command';
  command: string;
  /** Label in the native menu (defaults to the command title; must match it when given). */
  label: string;
  /** Display form with Mod ("Mod+Shift+P"); must equal the command's shortcut. */
  shortcut?: string;
  /** false: show the accelerator but let the renderer/editor handle the key (keys Monaco owns). */
  registerAccelerator?: boolean;
  optional?: boolean;
  /** Only on this platform. */
  platform?: 'darwin' | 'win32';
}
export interface MenuRoleItem { type: 'role'; role: NativeRole; label?: string; accelerator?: string; platform?: 'darwin' | 'win32'; dev?: boolean }
/** Items the main process implements itself (open logs folder, restart engine). */
export interface MenuNativeItem { type: 'native'; id: 'openLogs' | 'restartEngine'; label: string }
export interface MenuSeparator { type: 'separator' }
export type MenuEntry = MenuCommandItem | MenuRoleItem | MenuNativeItem | MenuSeparator;
export interface MenuDef { id: string; label: string; items: MenuEntry[]; platform?: 'darwin' | 'win32' }

const sep: MenuSeparator = { type: 'separator' };
const cmd = (command: string, label: string, shortcut?: string, extra: Partial<MenuCommandItem> = {}): MenuCommandItem => ({
  command, label, ...(shortcut ? { shortcut } : {}), ...extra,
});
const role = (r: NativeRole, extra: Partial<MenuRoleItem> = {}): MenuRoleItem => ({ type: 'role', role: r, ...extra });

export const MENUS: MenuDef[] = [
  {
    id: 'app', label: 'DbStudio', platform: 'darwin',
    items: [
      cmd('help.about', 'About DbStudio'),
      cmd('help.checkForUpdates', 'Check for Updates…'), sep,
      cmd('view.settings', 'Settings…', 'Mod+,'), sep,
      role('services'), sep, role('hide'), role('hideOthers'), role('unhide'), sep, role('quit'),
    ],
  },
  {
    id: 'file', label: '&File',
    items: [
      cmd('file.newConsole', 'New query console', 'Mod+N'),
      cmd('file.newConnection', 'New connection…', 'Mod+Shift+N'),
      sep,
      cmd('file.open', 'Open SQL file…', 'Mod+O'),
      cmd('file.openSqlite', 'Open a SQLite database file…'),
      cmd('file.sampleDb', 'Open the sample database'),
      sep,
      cmd('file.save', 'Save', 'Mod+S'),
      cmd('file.saveAs', 'Save as…', 'Mod+Shift+S'),
      sep,
      cmd('tab.close', 'Close tab', 'Mod+W'),
      cmd('tab.reopenClosed', 'Reopen closed tab', 'Mod+Shift+T'),
      sep,
      cmd('view.settings', 'Settings…', 'Mod+,', { platform: 'win32' }),
      { ...sep },
      role('quit', { label: 'Exit', platform: 'win32', accelerator: 'Alt+F4' }),
    ],
  },
  {
    id: 'edit', label: '&Edit',
    items: [
      role('undo'), role('redo', { platform: 'win32', accelerator: 'Ctrl+Y' }), role('redo', { platform: 'darwin' }), sep, role('cut'), role('copy'), role('paste'), role('delete'), sep, role('selectAll'),
      sep,
      cmd('format.document', 'Format SQL', 'Shift+Alt+F', { optional: true, registerAccelerator: false }),
      cmd('format.selection', 'Format selection', 'Mod+K Mod+F', { optional: true, registerAccelerator: false }),
      cmd('snippet.insert', 'Insert snippet…', 'Mod+J', { optional: true, registerAccelerator: false }),
      cmd('snippets.manage', 'Manage snippets…', undefined, { optional: true }),
    ],
  },
  {
    id: 'view', label: '&View',
    items: [
      cmd('view.commandPalette', 'Command palette…', 'Mod+Shift+P'),
      cmd('view.goToObject', 'Go to database object…', 'Mod+P'),
      sep,
      cmd('view.toggleSidebar', 'Toggle side panel', 'Mod+B'),
      cmd('view.explorer', 'Show database explorer', 'Mod+Shift+E'),
      cmd('view.history', 'Show query history', 'Mod+Shift+H'),
      cmd('connections.showActive', 'Show active connections'),
      // M2 (docs/PLAN-M2.md 1.3): Ctrl+Shift+L is explain actual and Ctrl+Alt+L the second Format SQL binding (user-01),
      // so logs use Mod+Alt+Shift+L (deviation from the plan's Mod+Alt+L).
      cmd('view.logs', 'Logs & activity', 'Mod+Alt+Shift+L', { optional: true }),
      cmd('er.open', 'ER diagram', 'Mod+Alt+E', { optional: true }),
      cmd('view.toggleResults', 'Toggle results pane', 'Mod+R'),
      cmd('view.maximizeResults', 'Maximize / restore results pane', 'Mod+Shift+R'),
      sep,
      cmd('view.toggleTheme', 'Toggle light / dark theme'),
      cmd('view.toggleDensity', 'Toggle compact density'),
      sep,
      cmd('view.zoomIn', 'Zoom in', 'Mod+='),
      cmd('view.zoomOut', 'Zoom out', 'Mod+-'),
      cmd('view.zoomReset', 'Reset zoom', 'Mod+0'),
      sep,
      role('togglefullscreen'),
      role('reload', { dev: true, accelerator: 'CmdOrCtrl+Alt+R' }),
      role('toggleDevTools', { dev: true }),
    ],
  },
  {
    id: 'query', label: '&Query',
    items: [
      cmd('run.statement', 'Run statement at cursor / selection', 'Mod+Enter', { registerAccelerator: false }),
      cmd('run.script', 'Run script', 'F5', { registerAccelerator: false }),
      cmd('run.cancel', 'Cancel running query', 'Shift+F5'),
      cmd('run.multi', 'Run on multiple connections…', 'Mod+Alt+Enter'),
      sep,
      cmd('explain.estimated', 'Explain plan (estimated)', 'Mod+L', { optional: true }),
      cmd('explain.actual', 'Explain plan (actual, runs the statement)', 'Mod+Shift+L', { optional: true }),
      cmd('params.edit', 'Query parameters…', 'Mod+Alt+P', { optional: true }),
      sep,
      cmd('tx.commit', 'Commit transaction', 'Mod+Alt+C'),
      cmd('tx.rollback', 'Roll back transaction', 'Mod+Alt+Z'),
      cmd('tx.toggleMode', 'Toggle auto-commit / manual transaction'),
    ],
  },
  {
    id: 'database', label: '&Database',
    items: [
      cmd('connections.change', 'Change connection…', 'Mod+Shift+K'),
      cmd('connections.changeDatabase', 'Change database…', 'Mod+Shift+D'),
      sep,
      cmd('designer.newTable', 'New table…', 'Mod+Alt+T', { optional: true }),
      cmd('designer.newView', 'New view…', undefined, { optional: true }),
      cmd('designer.newProcedure', 'New procedure…', undefined, { optional: true }),
      cmd('designer.newFunction', 'New function…', undefined, { optional: true }),
      cmd('designer.newTrigger', 'New trigger…', undefined, { optional: true }),
      cmd('designer.edit', 'Design / edit object', 'F4', { optional: true }),
      cmd('data.open', 'Open table data', 'Mod+Alt+D', { optional: true }),
      cmd('codegen.open', 'Generate code…', 'Mod+Alt+G', { optional: true }),
      sep,
      cmd('connections.refreshCatalog', 'Refresh catalog'),
      cmd('connections.disconnectAll', 'Disconnect all'),
    ],
  },
  {
    id: 'window', label: 'Window', platform: 'darwin',
    items: [role('minimize'), role('zoom'), sep, role('front')],
  },
  {
    id: 'help', label: '&Help',
    items: [
      cmd('view.shortcuts', 'Keyboard shortcuts', 'F1'),
      cmd('help.welcome', 'Show welcome screen'),
      sep,
      { type: 'native', id: 'openLogs', label: 'Open logs folder' },
      { type: 'native', id: 'restartEngine', label: 'Restart engine' },
      sep,
      cmd('help.checkForUpdates', 'Check for Updates…', undefined, { platform: 'win32' }),
      cmd('help.about', 'About DbStudio', undefined, { platform: 'win32' }),
    ],
  },
];

/** A context menu / toolbar entry: a command id, a submenu of entries, or a separator. */
export type ContextEntry =
  | { command: string; optional?: boolean; label?: string; /** Hidden (not greyed) when disabled. */ hideDisabled?: boolean }
  | { submenu: string; label: string; icon?: string; entries: ContextEntry[] }
  | 'separator';

const c = (command: string, optional = false, label?: string): ContextEntry => ({ command, ...(optional ? { optional } : {}), ...(label ? { label } : {}) });
/** Creation items that only apply to some dialects (e.g. no procedures on SQLite): hidden when not applicable. */
const n = (command: string): ContextEntry => ({ command, optional: true, hideDisabled: true });
/** Shown only when enabled (e.g. Drop… on a read-only connection is hidden). */
const h = (command: string): ContextEntry => ({ command, hideDisabled: true });

/** Generate SQL ▸ SELECT / INSERT / UPDATE / DELETE (inserted at the caret of the active console, else a new one). */
const GENERATE_SQL: ContextEntry = {
  submenu: 'explorer.generateSql', label: 'Generate SQL', icon: 'CodeXml',
  entries: [c('explorer.generateSelect'), h('explorer.generateInsert'), h('explorer.generateUpdate'), h('explorer.generateDelete')],
};

/** Explorer context menus by node kind (args: a CommandTarget). */
export const CONTEXT_MENUS: Record<string, ContextEntry[]> = {
  'explorer.connection': [
    c('connections.openConsole'), 'separator',
    c('designer.newTable', true), n('designer.newView'), n('designer.newTrigger'), 'separator',
    c('connections.edit'), c('connections.duplicate'), 'separator',
    c('connections.refreshCatalog'), c('connections.disconnect'), c('explorer.copyName'), 'separator',
    // M2: ER diagram (M2-ER) and logs & activity (M2-L)
    c('er.open', true), c('view.logs', true), 'separator',
    c('connections.delete'),
  ],
  'explorer.container': [
    c('connections.openConsole'), 'separator',
    n('designer.newTable'), n('designer.newView'), n('designer.newProcedure'), n('designer.newFunction'), n('designer.newPackage'),
    n('designer.newTrigger'), 'separator',
    c('connections.refreshCatalog'), c('er.open', true), c('explorer.copyName'),
  ],
  'explorer.table': [
    c('data.open', true), c('explorer.selectTop'), GENERATE_SQL, 'separator',
    c('designer.edit', true), c('explorer.openDdl'), c('explorer.copyDdl'), c('codegen.open', true),
    c('er.openRelated', true), n('er.openSelected'), n('designer.newTrigger'), 'separator',
    c('connections.openConsole'), c('explorer.copyName'), c('explorer.copyQualifiedName'), 'separator',
    c('designer.newTable', true), c('connections.refreshCatalog'), 'separator',
    h('explorer.truncate'), h('explorer.drop'),
  ],
  'explorer.view': [
    c('data.open', true), c('explorer.selectTop'), GENERATE_SQL, 'separator',
    c('designer.edit', true), c('designer.editAsScript', true), c('explorer.openDdl'), c('explorer.copyDdl'), c('codegen.open', true),
    c('er.openRelated', true), 'separator',
    c('connections.openConsole'), c('explorer.copyName'), c('explorer.copyQualifiedName'), 'separator',
    c('designer.newView', true), c('connections.refreshCatalog'), 'separator',
    h('explorer.drop'),
  ],
  'explorer.routine': [
    // Procedures, functions and Oracle packages (hidden for triggers and on SQLite): the parameter form.
    { command: 'routine.execute', optional: true, hideDisabled: true, label: 'Execute…' }, 'separator',
    c('designer.edit', true), c('designer.editAsScript', true), c('explorer.openDdl'), c('explorer.copyDdl'), c('codegen.open', true), 'separator',
    c('connections.openConsole'), c('explorer.copyName'), c('explorer.copyQualifiedName'), 'separator',
    c('designer.newProcedure', true), c('connections.refreshCatalog'), 'separator',
    h('explorer.drop'),
  ],
  'explorer.object': [
    c('explorer.openDdl'), c('explorer.copyDdl'), c('designer.edit', true), 'separator',
    c('connections.openConsole'), c('explorer.copyName'), c('explorer.copyQualifiedName'), 'separator',
    c('connections.refreshCatalog'), 'separator',
    h('explorer.drop'),
  ],
  'explorer.folder': [c('connections.connectFolder'), c('connections.newInFolder')],

  // ---- M2 (docs/PLAN-M2.md 2.5): source connections and source module nodes. Command ids are reserved here; each
  // feature package registers them in its commands.ts (optional until then). Args: a SourceTarget (commands/types.ts),
  // or a ConnectionTarget on the connection row.
  /** Redis/MongoDB/Kafka connection row (no consoles, no designer). */
  'explorer.sourceConnection': [
    c('connections.openWorkspace'), c('view.logs', true), 'separator',
    c('connections.edit'), c('connections.duplicate'), 'separator',
    c('connections.disconnect'), c('explorer.copyName'), 'separator',
    c('connections.delete'),
  ],
  'explorer.redis.db': [c('redis.openBrowser', true), c('redis.newKey', true), 'separator', c('redis.flushDb', true)],
  'explorer.redis.folder': [c('redis.openPattern', true), 'separator', c('redis.deletePattern', true)],
  'explorer.redis.key': [
    c('redis.openKey', true), c('redis.renameKey', true), c('redis.setTtl', true), 'separator',
    c('redis.copyKey', true), c('redis.copyValueJson', true), 'separator', c('redis.deleteKey', true),
  ],
  'explorer.mongo.db': [c('mongo.newCollection', true), c('mongo.importInto', true), 'separator', c('mongo.dropDatabase', true)],
  'explorer.mongo.collection': [
    c('mongo.openDocuments', true), c('mongo.aggregate', true), c('mongo.schema', true), c('mongo.indexes', true), c('mongo.explain', true),
    c('mongo.validation', true), 'separator', c('mongo.import', true), c('mongo.export', true), 'separator',
    c('mongo.renameCollection', true), c('mongo.dropCollection', true),
  ],
  'explorer.kafka.cluster': [c('kafka.overview', true), c('kafka.createTopic', true)],
  'explorer.kafka.topic': [
    c('kafka.browseMessages', true), c('kafka.produce', true), c('kafka.topicConfigs', true), c('kafka.topicGroups', true), 'separator',
    c('kafka.addPartitions', true), c('kafka.deleteTopic', true),
  ],
  'explorer.kafka.group': [c('kafka.openGroup', true), c('kafka.resetOffsets', true), 'separator', c('kafka.deleteGroup', true)],
  tab: [
    c('tab.close'), c('tab.closeOthers'), 'separator', c('tab.rename'), c('tab.duplicate'),
    { command: 'designer.compareWithServer', optional: true, hideDisabled: true }, 'separator', c('tab.reopenClosed'),
  ],
  'history.entry': [
    c('history.openEntry'), c('history.insertEntry'), c('history.copyEntry'), c('history.togglePin'), 'separator', c('history.deleteEntry'),
  ],
  'connections.session': [c('sessions.cancel'), c('sessions.disconnect'), 'separator', c('connections.disconnectAll')],
  /** A session no open tab owns (left over from a reload). */
  'connections.orphan': [h('sessions.disconnect'), h('sessions.rollbackClose'), 'separator', c('sessions.closeOrphans')],
};

/** Console toolbar (left to right). */
export const CONSOLE_TOOLBAR: ContextEntry[] = [
  c('run.statement'), c('run.script'), c('run.cancel'), c('run.multi'), 'separator',
  c('connections.change'), c('connections.changeDatabase'), c('tx.toggleMode'), c('tx.commit'), c('tx.rollback'), 'separator',
  c('explain.estimated', true), c('explain.actual', true), c('format.document', true), c('codegen.query', true),
  { command: 'designer.compareWithServer', optional: true, hideDisabled: true },
];

/** Top bar (app header) buttons. */
export const TOPBAR: ContextEntry[] = [
  c('view.toggleSidebar'), c('file.newConsole'), c('file.newConnection'), c('view.commandPalette'), c('view.goToObject'),
  c('view.history'), c('view.toggleTheme'), c('view.settings'), c('view.shortcuts'),
];

/** Command ids shown in the native/in-app menus (for coverage checks). */
export function menuCommandIds(platform: 'darwin' | 'win32' = 'win32'): MenuCommandItem[] {
  const out: MenuCommandItem[] = [];
  for (const m of MENUS) {
    if (m.platform && m.platform !== platform) continue;
    for (const it of m.items) {
      if ((it.type === undefined || it.type === 'command') && (!('platform' in it) || !it.platform || it.platform === platform)) out.push(it as MenuCommandItem);
    }
  }
  return out;
}
