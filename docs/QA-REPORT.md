# DbStudio M1.5 â€” Final QA Sign-off

**Author:** Fable, lead architect  
**Date:** 2026-10-18  
**Scope:** QA rounds 1â€“3 (round limit reached) on the M1.5 tree at `73173dd` plus the uncommitted round-3 working tree (68 modified, 16 new files, +1401/âˆ’332).

---

## 1. Verdict

**Ship-ready, with two conditions.**

1. **SQLite-backed functionality is release quality.** Every blocker and major finding was fixed and re-verified against a live engine (API repros and browser screenshots), the final gate is green on all six required suites, and my own spot-check of the code (section 3) confirmed every claim I sampled.
2. **SQL Server and Oracle are code-and-golden verified only.** 48 SQL Server and 55 Oracle integration tests skipped in every gate because no live server was available. Several round-1 fixes land exclusively on those paths (T-SQL `OUTPUT â€¦ INTO @ins`, the T-SQL identity rebuild with FK/trigger/permission recreation, `dm_exec_describe_first_result_set_for_object`, Oracle identity refusal, lock-holder descriptions). I recommend one manual smoke pass against a real SQL Server and Oracle before those providers are advertised as GA for M1.5, and I would not block the release on it because the paths are fully covered by unit, golden and ScriptDom-parse tests.

Housekeeping before merge: the round-3 changes are **not yet committed** (see section 9).

**Totals across three rounds:** 154 findings accepted and resolved, 16 rejected (all duplicates or spec-conformant behaviour), 9 feature proposals accepted and implemented, 0 blockers open, 0 majors open.

| Round | Accepted | Rejected | Gate |
|---|---|---|---|
| 1 | 92 | 13 | Green (lint pre-existing failure noted, fixed in round 2) |
| 2 | 41 | 2 | Green (3 test repairs, all test-side) |
| 3 | 21 | 1 | Green (1 test repair, test-side) |

Final gate (round 3): tsc clean; UI 950 passed / 2 skipped; test:intel 661/661; build OK; engine Core 335 / Sqlite 95 / SqlServer 218 (+48 skipped) / Oracle 266 (+55 skipped), 0 failed; desktop 46 passed / 1 skipped (POSIX-only); QA engine rebuilt, health OK; `npm run lint` exit 0 (confirmed by me today). Bundle +254.7 KB gzipped over the M1 baseline (budget 600 KB).

---

## 2. What the input did not let me see

The item list I received was truncated after `features-20`. I did not see the `code-*` findings or any `*-r1-*` / `*-r2-*` items as records; for those I relied on the round notes (which list what the lead verified in code) and on my own code reading. Round 1 also records that its own code-findings input was truncated after `code-07`. Nothing in the gate results or in the code I read suggests an unaddressed item hiding there, but the sign-off for `code-08+` rests on the round-2 and round-3 lead verification rather than on item records.

---

## 3. Spot-check of "resolved" claims (my own verification, today)

I read the code behind 20 resolved claims spanning all five areas. **All 20 hold.**

| Claim | Where I verified it |
|---|---|
| logic-01: cancel after completion reported as Ok + warning, not Cancelled | `AdoSessionBase.cs:995` prefix "Cancel arrived after the statement completed"; test at `B1EngineTests.cs:145` |
| logic-02: CommandTimeout no longer 0 on SQLite | `AdoSessionBase.cs:178-191` virtual `DefaultCommandTimeoutSeconds`; `SqliteSession.cs:58` uses busyTimeout |
| logic-03: manual-mode BEGIN gated on classifier | `AdoSessionBase.cs:55,249` `!Classification.IsQueryOnly \|\| HasSavepoint` |
| logic-04: explain never sends confirmedDestructive implicitly; intel classifier not regex | `PlanView/explain.ts:5,15,55-58,85` |
| logic-05: multi-run skips read-only targets unless acked | `multiRun.ts:95-117` |
| logic-06: catalog.changed null-database refresh | `store/catalog.ts:200-214` |
| logic-07: no DROP VIEW for a new view (all three scripters) | `SqliteDdlScripter.cs:387-392`, `SqlServerDdlScripter.cs:487`, `OracleDdlScripter.cs:359` |
| logic-08/r1-03: orphan flag honoured | `store/sessions.ts:67-112` |
| logic-19: skipHistory honoured in engine | `ExecutionService.cs:27,192`, `SessionEndpoints.cs:76` |
| styles-01/08/09: shadow DOM off, mono font, suggest line height | `editor/monacoOptions.ts:14-17` |
| styles-04: border tokens amended, alias kept | `tokens.css:22-23,128-129,274` |
| styles-r1-01: column width effect-order regression | `DataGrid.tsx:265-279` single effect keyed on `sameColumns` |
| styles-r2-02: 10-13 px results-pane icons normalised by CSS | `app.css:88-117` container rule; `theme/iconSizes.test.ts` |
| design-02: danger dialogs autofocus Cancel; ack gates the button | `ConfirmDialog.tsx:54,69,74` |
| design-04: Shift+F10 / ContextMenu in grid | `DataGrid.tsx:779,904` |
| design-13: Set NULL is Mod+Alt+N; no hard-coded Ctrl+0 | `DataTab/commands.ts:104`; grep of DataGrid finds no `k === '0'` |
| r3: NOT NULL skip no longer silent | `DataGrid.tsx:669-675` toast with reason |
| r3: rolled-back banner with Re-run | `ResultsPane.tsx:280-483` |
| features-10: T-SQL insert uses `DECLARE @ins TABLE â€¦ OUTPUT INTO`, SCOPE_IDENTITY fallback | `data/sqlgen.ts:233-250` |
| features-11: Oracle identity-on-existing-column refused | `OracleDdlScripter.cs:180` |
| r2/r3 CI: lint blocking, test:intel step, bundle check with M1 baseline | `.github/workflows/ci.yml` |
| r2 lint: `use()` helper renamed in python.ts | grep finds 0 `use(` calls; `npm run lint` exit 0 |
| r3: tab strip never shrinks, scrolls | `app.css:744-766` |
| r3: formatter ALTER routine guard | `format/index.ts:156-167` |

---

## 4. Found and fixed, per area

### Styles (24 findings round 1, plus r1/r2 follow-ups)
- **Monaco theming:** context menu rendered in a shadow root with no tokens (transparent, no border/shadow); fixed with `baseMonacoOptions()` (`useShadowDOM:false`, token font, suggest sizing) now used by SqlEditor, CodeView and (round 2) CompareDialog. Light-theme suggestion row was white-on-light-blue; all selected/focus/hover foregrounds now derived from tokens with a 4.5:1 test. Find widget blends, no editor focus ring, hard-coded font stack, bracket colours, legacy literal themes: all replaced by `buildMonacoTheme` from `tokens.css`.
- **Tokens and contrast:** `--border`/`--border-strong` could not meet the 5.1 ratios; spec table amended (`#ccd1d9`/`#8a919c` light, `#41464f`/`#6f7682` dark) with `--border-control` kept as a deprecated alias. `--fg-disabled` was used for informative text (2.5:1); now lint-enforced to disabled selectors only. Derived tokens added for text on selected rows, danger text, soft badges; `--obj-trigger` no longer equals `--danger`. Full contrast matrix tested.
- **Layout at zoom and small windows:** 150% zoom clipped the console toolbar and collapsed the grid; results toolbar now uses OverflowToolbar, a pixel minimum (header + 5 rows, capped at 68%) governs the split, short windows default to a 40/60 split, dock width clamped, top bar compacts to icons (round 3). Tabs never shrink; the strip scrolls.
- **Grid:** uniform 140 px columns on fast results (effect-order regression) fixed; ellipsis drawing, zebra, hover, 13 px NULL/DEFAULT placeholders, dark deleted-row contrast, canvas height capped to content.
- **Consistency:** ~40 duplicated selectors across app.css/shell.css merged with a parser test; icon sizes 16/14 px and stroke 1.5 enforced by CSS and tests; type scale and weights tokenised; 28 px control height unified; production Run marker moved off the focus ring.

### Logic (24 findings round 1, plus r1/r2 follow-ups)
- **Blocker, data integrity:** a cancelled statement that had already auto-committed was reported "Cancelled, 0 rows". Now Cancelled only on a real driver abort; otherwise Ok with rowsAffected and an explicit warning. Single-statement DML transactions that fail or cancel are rolled back.
- **Locks and cancel:** CommandTimeout=0 made SQLite lock waits infinite and uncancellable. Busy timeout (default 30 s) plus cancel-driven early exit; SQLITE_BUSY now names the holding session and what to do. Designer apply gets the same wording.
- **Manual transaction mode:** a SELECT opened a transaction and held a SHARED lock. BEGIN is now lazy on the first non-query batch; user-typed BEGIN tracked via autocommit state. Round 2 added savepoints for manual-mode grid saves so a rollback really undoes.
- **Read-only bypasses (3):** explain "actual" always sent `confirmedDestructive`; multi-run confirmed every target; export lacked `EnforceReadOnly`. All closed; the override now requires a ticked acknowledgement.
- **Sessions:** leaked on reload, 2 per data tab, status bar count wrong. Re-adoption by tabId on boot and reconnect, pagehide keepalive DELETE, engine-side orphan reaping (90 s), one session per data tab with idle release, engine-wide counts in the status bar.
- **Catalog refresh after DDL** on SQLite (null database key), **view silently replaced** on create/rename (now a name-conflict check), explain without params, truncated values copied as complete, data tab double-loading and impure updater, BETWEEN date-only upper bound parity, formatter resync after an unparseable statement, missing-parameter validation, filter perf test flakiness, FK chevron click, delete-connection warning (force flag wiring fixed in round 2), codegen defaulted columns and parameter type inference, per-column JSON number mode.

### Design (23 findings round 1, plus r1/r2 follow-ups)
- **Safety:** danger confirmations focused the destructive button (Enter wrote to a read-only connection); Cancel now autofocused, ack required. Ctrl+S with an open cell editor lost the edit and the overlay floated over the modal; editor committed first, portal z-index below dialogs.
- **Keyboard and focus:** focus lost to `<body>` after palette/switcher/last tab/Explain; capture/restore helper everywhere, F6/Shift+F6 region cycling, Alt+1/2/3 focus commands, Shift+F10 grid menus, submenus reachable, Explain/Format/Snippet shortcuts work outside Monaco, data/designer/codegen open with focus in the right place, filter bar Esc restores focus (round 2), pointer hover no longer hijacks a keyboard-opened menu (round 3).
- **Registry conformance:** results/data-tab toolbar actions, Export and Copy-as menus became registered commands; `Code â–¾` added to the results toolbar; hard-coded "Ctrl+" strings replaced with `displayShortcut`/`ariaKeyShortcuts` (macOS correct) with a lint test; Set NULL moved off Ctrl+0.
- **Explorer menus:** Drop, Truncate, Generate SQL submenu, Copy DDL, New view/trigger added.
- **Dialogs and panels:** connection dialog height jump, one read-only label per provider, client-side validation; designer DDL preview collapses when empty, validation only after interaction, type combobox affordance; palette fuzzy matching tightened with unique titles; error messages get "Did you mean X? [Replace]"; private React roots moved into App hosts.

### Features (20+ findings round 1, plus r1/r2 follow-ups)
- **Atomic SQLite edit script** (F4): a failing CREATE after reload permanently dropped the trigger/view; edit registration is now persisted in the tab and the run goes through one transactional `/designer/apply`.
- **Codegen correctness:** Java missing `java.time`/UUID imports; TS better-sqlite3 binding booleans/Dates raw and mis-reading 0/1 (plus the datetime text format and non-UTC round trip in rounds 2â€“3); Python sqlite3 binding Decimal; names (`CustomersRow`/`CustomersQuery`) owned by generators.
- **Designer/engine DDL:** T-SQL `OUTPUT INSERTED` without INTO (Msg 334 on triggered tables); Oracle `MODIFY â€¦ AS IDENTITY` always rejected (now refused with guidance, warnings only on narrowing); T-SQL identity rebuild lost triggers, permissions, extended properties and failed on FK-referenced tables (now recreated or refused with a clear reason; round 2 added a further guard).
- **Shell/tab logic:** plan and snippets tabs rendered over every tab (ViewTabHost); designer key not normalised (duplicate designers); proc result inference now uses `dm_exec_describe_first_result_set_for_object` without executing; wizard F5 ran only the placeholder; properties strip stale after add; spurious clustered-index warning; data-tab filter/sort/search persisted.

### Code quality / CI
- oxlint rules-of-hooks failure at HEAD (test helpers named `use*`, codegen `use()`): fixed by renaming, no rule weakening; lint is now a blocking CI step and exits 0.
- `test:intel` step added to CI (editor and IntelliSense tests were excluded from `npm test` and never ran in CI).
- Bundle-size guard re-baselined to the real M1 build (bfaac37) with a note never to re-baseline on the current tree.
- `IDbProvider` additive default members waived in PLAN 5.5.
- `shot.mjs` leaked headless Edge processes and temp profiles; cleanup handlers added.
- Flaky tests made robust (filter perf ratio-based, formatter perf warm-up, `dataTabFocus` store reset, ConnectionDialog/CommandButton assertions aligned to the new labels and key order).

---

## 5. Features added (9 accepted proposals)

| Id | Feature |
|---|---|
| design-p1 | Region focus commands: Alt+1/2/3, F6/Shift+F6 cycling with region outline; Ctrl+M registered as `editor.toggleTabFocus` |
| design-p3 | Grid actions as registered commands (export, copy-as, value viewer, clear sort, reload, design, codegen) reachable from the palette |
| design-p4 | Explorer object actions: Drop, Truncate, Generate SQL (SELECT/INSERT/UPDATE/DELETE), Copy DDL |
| design-p8 | Error help: "Did you mean X? [Replace]" from the loaded catalog; folded "Finished with errors" into the header |
| styles-p2 | Split and dock memory: per-tab split ratio, double-click reset, dock width clamp with icon-only dock tabs below 260 px |
| logic-p2 | Session re-adoption after reload/reconnect, orphan toast, engine-side orphan reaping, idle session release in data tabs |
| prop-01 | Copy/export with full values: `serializeComplete` fetches truncated cells, refuses SQL INSERT when incomplete, client-side export for results and data tabs |
| code-p3 (r1, r2) | Codegen: defaulted NOT NULL columns omitted from INSERT models with ORM annotations; query parameter type inference from compared columns; T-SQL proc result inference without execution |
| (r3 design decisions) | Filter changes with pending edits become a visible deferred draft ("Save and filter" / "Discard and filter", auto-apply when pending clears); keyless paging chooses a stable order from a COUNT before page 1; rolled-back saves show a banner with Re-run |

---

## 6. Rejected or deferred, with reasons

**Rejected as duplicates (14):** features-02â†’logic-07, features-03â†’logic-06, features-04/design-05/styles-24â†’logic-08/09, features-06/15â†’logic-13, features-21â†’logic-19, features-22â†’logic-22, code-07â†’features-10, design-12â†’styles-03, styles-15â†’styles-r1-01, code-r1-02â†’logic-r1-01, features-r2-05â†’code-r2-01, logic-r2-04(2)â†’styles-r2-03. In each case the canonical item absorbed the extra detail and was resolved.

**Rejected on the merits (2):**
- design-17: "68187.54000000001" is the correct shortest round-trip of the stored double; three timings measure different things. Status-bar part resolved under logic-14.
- design-23: Plan as a separate tab is the specified design (section 2 A5); SQLite's EXPLAIN QUERY PLAN genuinely names aliases.

**Deferred by decision (narrowed acceptances):**
- Explorer **Rename** and **Export/Import** actions (design-08) â€” out of M1.5 scope; Drop/Truncate/Generate/Copy DDL shipped.
- **Oracle REF CURSOR result-column inference** (features-14) â€” T-SQL inference shipped; Oracle wrappers stay untyped.
- T-SQL identity **rebuild** scripting is refused (not attempted) when dependents are unknown, schema-bound objects exist, triggers are encrypted, an FK-referenced column would be dropped, or a triggered table is renamed in the same rebuild. Refusal with a clear message was chosen over a best-effort rebuild.
- Oracle identity on an existing column is **refused** rather than scripted as a rebuild (the brief allowed either).

---

## 7. Still open

No blocker or major is open. Items below are polish or housekeeping.

| Item | Severity | Recommended next step |
|---|---|---|
| Round-3 changes uncommitted (68 M, 16 ??) | housekeeping | Integrator commits as "QA round 3" after a final `npm test` + `dotnet test` on the merged tree (both were green in the gate). |
| Stray `E:\DbStudio\engine.pid` (untracked, dead PID 1166, not gitignored) | housekeeping | Delete it; add `engine.pid` to `.gitignore` if a QA script writes it. |
| oxlint reports `react(refs)` warnings in `DataTabView.tsx` (lines 225, 420, 539, 679, 752): refs read during render | polish | Non-blocking (warnings, exit 0). Move the reads into effects/handlers or document why they are safe; otherwise a future rule upgrade will turn them into errors. |
| 150% zoom at 1024x680: only ~3.5 data rows fit (minimum height capped at 68% of console height) | polish | Documented limit at the Electron-minimum window size. Accept, or lower the editor minimum at that breakpoint. |
| Light-theme zebra striping (`#fafbfc` on `#fff`) is practically invisible | polish | Spec value; consider a darker `--bg-grid-alt` in a spec amendment. |
| Duplicate connection names accepted silently | polish | Add a uniqueness warning in ConnectionDialog. |
| Oracle `VARCHAR2(200 CHAR)` â†’ `VARCHAR2(400 BYTE)` gives no narrowing warning | polish | Extend `TypeChangeWarning` to treat a CHARâ†’BYTE unit change as potentially narrowing. |
| JSON copy: a boolean in an int-kind column switches the column to string mode while the boolean stays a JSON boolean | polish | Edge case in `lib/serialize.ts numericColumnMode`; add a test and coerce consistently. |
| Python codegen `py_compile` and sqlite3 round-trip tests skipped locally (no Python 3 on the QA machine); Java snapshots not compiled (no javac) | test gap | Both are designed to run on the GitHub runners (which ship Python); confirm they execute in the first CI run and are not skipped there. Consider adding a JDK to the Windows job so the Java import-completeness scan is backed by a compile. |
| Formatter 150 ms perf test: budget met only after extra JIT warm-up on a loaded machine | test stability | Fine as is; if it flakes again on CI, gate the absolute budget behind `DBSTUDIO_PERF=1` like the filter perf test. |

---

## 8. Residual risks

1. **SQL Server and Oracle not exercised against live servers.** 48 + 55 integration tests skipped in every gate (no Docker). Paths that were fixed this cycle and have only unit/golden/parse coverage: T-SQL `OUTPUT INTO @ins` / `SCOPE_IDENTITY` insert; T-SQL identity rebuild with FK, trigger, permission and extended-property recreation (the five new catalog queries pass the ScriptDom parse test but have never returned real rows); `dm_exec_describe_first_result_set_for_object` inference; SQL Server and Oracle lock-holder descriptions; Oracle identity refusal and narrowing warnings; PL/SQL filter identifier quoting and ORDER BY hoisting; Oracle `CREATE OR REPLACE` view editing. **Mitigation:** one manual smoke pass per provider using `docs/qa/m15-walkthrough.md` with `DBSTUDIO_IT=1` before announcing those providers for M1.5.
2. **Spec amendments made during QA.** Border tokens, `--text-xs`/`--text-2xl`, icon-size dense spots, Set NULL = Mod+Alt+N, shortcut display order Ctrl,Shift,Alt, 28/24 px density rule, bundle baseline, `IDbProvider` waiver. All are recorded in `docs/PLAN-M1.5.md`; anyone working from an older copy of the plan will see conflicts with the tests.
3. **Unseen items.** As noted in section 2, `code-*` and round-2/3 item records were truncated from my input; sign-off for those rests on the lead notes and the green gates rather than on my re-reading each record.
4. **Session re-adoption relies on the engine's `orphan` flag and a per-tab client id in sessionStorage.** Behaviour across multiple windows was tested; behaviour across an engine restart mid-transaction is the normal "transaction lost" case and is reported, not recovered.
5. **Manual-mode savepoints on SQLite.** Verified by test and live repro that a rollback undoes a saved grid edit; the equivalent on SQL Server/Oracle uses provider savepoint syntax that is unit-tested only (see risk 1).
6. **Performance tests are wall-clock.** Two were made ratio-based or warmed up this cycle; others may surface as flakes on slow CI runners rather than as real regressions.

---

## 9. Integrator checklist

1. `git status` â€” review the 16 new files (all tests, one `DeferredNotice.tsx`, two formatter fixtures) and the 68 modified files; delete `engine.pid`.
2. Commit the round-3 tree; run CI. Confirm the Windows job executes the Python round-trip tests (not skipped) and that `UI lint`, `UI editor/IntelliSense tests` and `UI bundle size` all appear as passing steps.
3. Rebuild `E:\DbStudio\.qa\engine` from the committed tree for any further manual checks (the round-3 gate already did this; no stale process was left).
4. Schedule the SQL Server and Oracle live smoke (risk 1) and record results against the items listed there.
5. File the section 7 polish items as follow-ups for the next milestone; none blocks M1.5.

Files referenced: `E:\DbStudio\docs\PLAN-M1.5.md`, `E:\DbStudio\docs\qa\m15-walkthrough.md`, `E:\DbStudio\.github\workflows\ci.yml`, `E:\DbStudio\engine\src\DbStudio.Core\Services\AdoSessionBase.cs`, `E:\DbStudio\ui\src\components\Grid\DataGrid.tsx`, `E:\DbStudio\ui\src\components\DataTab\DataTabView.tsx`, `E:\DbStudio\engine.pid`.
