# M1.5 keyboard-only walkthrough (QA 5.3)

Goal: do the whole daily loop without touching the mouse, and confirm that focus is never lost (there is always a
visible focus ring or a caret). Run it on SQLite (sample database) first, then on SQL Server and Oracle (Docker).
Shortcuts are written for Windows; on macOS read Ctrl as ⌘ (Cmd). Every step names the command id so a failure can
be traced to the registry (`window.__dbstudio.commands.list()` in a dev build lists them all).

Setup: fresh profile (browser: `http://localhost:5177/?fresh` with `npm run dev:mock`, or a new
`DBSTUDIO_DATA_DIR` with a live engine). Window 1280×800, then repeat steps 1–6 at 1024×680 and at 150 % zoom
(Ctrl+= five times).

| # | Keys | Expected | Command id |
|---|---|---|---|
| 1 | (launch) | Welcome screen "Connect to a database" with SQL Server / Oracle / SQLite cards, "Open a SQLite file", "Try the sample database". No modal. | — |
| 2 | Tab to "Try the sample database", Enter | `POST /sample-db`; console "Sample: Shop" opens with a query; the explorer shows "Sample: Shop"; toast shows the file path. | `file.sampleDb` |
| 3 | Ctrl+Enter | Statement under the cursor runs; results grid shows rows; the screen reader announces "N rows, X ms"; a one-time tips strip appears under the toolbar. | `run.statement` |
| 4 | Ctrl+Shift+N | Connection dialog, focus in the first field. Pick SQLite (arrows in the type list), type a file path, Tab to *Test connection*, Enter: inline result with server version and time. Esc closes; Enter = *Connect* (saves and opens a console). | `file.newConnection` |
| 5 | Ctrl+Shift+K | Connection switcher under the pill: Recent group first, then folders; type to fuzzy-filter; Enter switches; open transactions ask first. | `connections.change` |
| 6 | Ctrl+Shift+D | Database/schema switcher (SQL Server / Oracle); hidden for SQLite. | `connections.changeDatabase` |
| 7 | Ctrl+P, type `t:ord` | Go-to-object lists `Orders` (table only); footer shows Enter / Ctrl+Enter / Shift+Enter / Alt+Enter. | `view.goToObject` |
| 8 | Shift+Enter | `Orders` is inserted at the caret of the active console; focus returns to the editor. | — |
| 9 | Ctrl+P, `orders`, Alt+Enter | Explorer opens on the left with `Orders` selected and scrolled into view; focus is on the tree. | — |
| 10 | Arrow keys, Right/Left, Enter on a table | Tree navigation; Enter opens the Data tab (WP-G) or the object details. Shift+F10 opens the context menu; arrows + first letters (typeahead) move; Enter runs. | context `explorer.table` |
| 11 | Ctrl+F (explorer focused) | Focus moves to the explorer filter; type `cust`; type chips: Tab to *Tables*, Space; column toggle searches column names. Esc clears. | `explorer.focusFilter` |
| 12 | Ctrl+Alt+D on a table | Data tab opens (WP-G). Ctrl+F in the grid opens the filter bar; Ctrl+Shift+F quick-filters by the focused cell. | `data.open`, `grid.filter`, `grid.quickFilterCell` |
| 13 | Edit a cell (Enter/F2), Ctrl+S | Pending-changes preview with SQL and parameters; Enter submits. | `grid.submitChanges` |
| 14 | F4 on a table | Table designer (WP-I). | `designer.edit` |
| 15 | Shift+Alt+F in a console | SQL is formatted (WP-H). | `format.document` |
| 16 | Ctrl+Alt+G on a table | Code generation panel (WP-I). | `codegen.open` |
| 17 | Ctrl+Alt+Enter | "Run on multiple connections": Space toggles connections ("All in <folder>" toggles a folder), Ctrl+Enter runs. A "Multi-run" tab shows `2/2 ok · …` and a strip per connection; Ctrl+Tab returns to the console. | `run.multi` |
| 18 | Ctrl+Shift+H | History panel in the dock, search box focused by Ctrl+F; chips Connection / Status / When / Only pinned via Tab + Enter/Space (menus: arrows, Space toggles, Esc closes); Enter on an entry reopens it in a new console. "No queries match — Clear filters" when empty. | `view.history`, `history.focusFilter` |
| 19 | Command palette → "Show active connections" | Sessions grouped by connection with state and elapsed time; Cancel / Close session; Disconnect per connection. | `connections.showActive` |
| 20 | Ctrl+W, Ctrl+Shift+T, Ctrl+1…9, Ctrl+Tab | Close, reopen, jump to a tab, switch to the previously used tab. | `tab.close`, `tab.reopenClosed`, `tab.goto1`, `tab.mruNext` |
| 21 | F1 (or Ctrl+K Ctrl+S) | Shortcut sheet; type "format" or "ctrl+shift"; no conflict banner. | `view.shortcuts` |
| 22 | Ctrl+, | Settings; Theme "Follow system"; switch OS theme: the app recolours live (editor, grid, menus). | `view.settings` |
| 23 | In a console: Ctrl+Enter, then Alt+3, then Ctrl+F | The statement runs; Alt+3 moves focus to the console's result grid (a short focus outline marks the region); Ctrl+F opens the grid filter bar. Alt+2 returns to the editor, Alt+1 focuses the explorer tree. | `run.statement`, `view.focusResults`, `grid.filter`, `view.focusEditor`, `view.focusExplorer` |
| 24 | F6 / Shift+F6 (repeat) | Focus cycles side panel → editor → results → status bar and back, with a visible outline each time. | `view.nextRegion`, `view.prevRegion` |
| 25 | Ctrl+M in the editor, then Tab | Tab moves focus out of the editor instead of indenting (Monaco tab-focus mode); Ctrl+M again restores indenting. Listed in the shortcut sheet (macOS: ⌃⇧M). | `editor.toggleTabFocus` |
| 26 | Ctrl+Shift+P, Esc; Ctrl+P, Esc; Ctrl+Shift+K, Esc; Shift+F10 in the tree, Esc | Each overlay gives focus back to where it was opened from (editor caret or tree row), never to the page body. Ctrl+W on the last tab focuses the first Welcome action. Ctrl+L from the toolbar or the grid explains the editor's statement. | `view.commandPalette`, `view.goToObject`, `connections.change`, `explain.estimated` |
| 27 | On a read-only connection: `update Customers set City='X' where Id=1`, Ctrl+Enter, then Enter | "Read-only connection" opens with Cancel focused, so Enter cancels. *Run with writes* stays disabled until "Allow this statement to write to …" is ticked (Space). | `run.statement` |

Pass criteria
- Every step works with the keyboard only and focus is always visible (2 px `--focus-ring`).
- Dialogs: Esc closes, Tab is trapped inside, Enter triggers the primary action, except danger confirmations: there
  Cancel has the focus (Enter = Cancel), and a read-only override needs its checkbox ticked first.
- The shortcut sheet shows no conflicts; `npm --prefix ui test` (commands.test.ts) is green.
- Steps 12–16 depend on WP-G/WP-H/WP-I; if a command is missing, the menu item is hidden (not disabled) and the
  coverage test reports it once the package's `commands.ts` exists.

Automated counterparts (vitest + jsdom): `src/commands/commands.test.ts` (coverage, conflicts, platform keys),
`src/components/Onboarding/Onboarding.test.tsx` (steps 1–2), `src/app/multiRun.test.ts` (step 17),
`src/components/CommandPalette/objectIndex.test.ts` (step 7, < 30 ms on 50k objects),
`src/components/Explorer/tree.test.ts` (step 11), `src/store/history.test.ts` (step 18),
`src/theme/tokens.test.ts` (tokens, contrast, no literal colours), `src/components/layout/shell.test.tsx` (steps 26–27:
menus, focus restore, danger confirmations), `src/app/shortcutLiterals.test.ts` (no hand-written "(Ctrl+…)" labels).
