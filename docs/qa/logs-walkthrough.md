# Logs & activity walkthrough (M2-L, docs/PLAN-M2.md section 8)

Pass/fail per step. Run in both themes and at 150 % app zoom. Keyboard-only steps are marked ⌨.

## Setup
- Engine log: always available (no connection needed). SQLite: the sample database (File → Open the sample database).
- SQL Server / Oracle / PostgreSQL / Redis / MongoDB / Kafka: the Docker fixtures (`engine/tests/docker/compose.yml`).
  For privilege checks create a low-privilege login per server: SQL Server `app` (public only), Oracle `APP` (CREATE
  SESSION only), PostgreSQL `app` (no roles), Redis ACL user `app` (`+@read -slowlog -latency -client`), MongoDB `app`
  (`read` on `shop`).
- PostgreSQL: `logging_collector=on` (the compose service sets it); a second run with `log_destination=csvlog` and one
  with `jsonlog` (PG 15+).
- `npm run dev:mock` covers every provider with fixtures (no Docker): `c_prod` SQL Server, `c_ora` Oracle (read-only),
  `c_pg`, `c_redis`, `c_mongo`, `c_kafka`, `c_shop` SQLite.

## Open
1. View → **Logs & activity** (Ctrl+Alt+Shift+L / ⌘⌥⇧L) opens `Logs & activity — <connection>` for the active tab's
   connection; with no tab it opens the engine log. Running it again activates the same tab.
2. Explorer: right-click a connection (relational or Redis/Mongo/Kafka) → **Logs & activity**.
3. Ctrl+Shift+P → "Open engine log" opens the engine log tab (`cid = engine`).
4. The tab survives a workspace restore (filters, source, sub-view restored; streams re-open).

## Sources (per provider)
5. SQL Server as sysadmin: Error log (Archive select: Current, #1…#6 with dates from sp_enumerrorlogs), SQL Agent log,
   system_health (XE), Activity. As `app`: Error log and system_health show the inline privilege state with the exact
   statement (`GRANT VIEW ANY ERROR LOG TO [app];` on 2022, `ALTER SERVER ROLE securityadmin ADD MEMBER [app];` before;
   `GRANT VIEW SERVER STATE TO [app];`) and **Copy GRANT** copies it. Express: Agent log "SQL Server Express has no SQL Agent".
6. Oracle: Alert log (V$DIAG_ALERT_EXT; ORA- lines with message_level 1 are errors), Unified audit trail, Activity. As `APP`:
   `GRANT SELECT ON V_$DIAG_ALERT_EXT TO "APP";`, `GRANT AUDIT_VIEWER TO "APP";`. 11g: "only SYS can read X$DBGALERTEXT".
7. PostgreSQL as superuser: Server log (stderr, csvlog, jsonlog each parse: DETAIL / HINT / STATEMENT fold into the entry,
   multi-line statements stay together), Top statements (pg_stat_statements, when installed), Activity. As `app`:
   `GRANT pg_monitor, pg_read_server_files TO "app";`. logging_collector off → reason + `ALTER SYSTEM SET logging_collector = on`.
   A managed service (RDS/Azure/Cloud SQL/Neon) → "use the provider's log console" without a grant.
8. Redis: Slow log, Latency monitor (threshold 0 → hint + one-click **CONFIG SET latency-monitor-threshold 100** when the
   connection is not read-only), MONITOR (live), Clients. As ACL user `app`: `ACL SETUSER app +slowlog` etc.
9. MongoDB: Server log (getLog; "showing the last 1024 lines" note), one Profiler source per database (profiling off →
   hint with `db.getSiblingDB("shop").setProfilingLevel(1, { slowms: 100 })`), Change stream (replica set only; standalone
   shows the reason), Current operations. As `app`: clusterMonitor grant text.
10. Kafka: Client log (librdkafka) with the note that Kafka has no broker log over the protocol; Activity lists DbStudio's
    own fetch jobs and tails (cancel = Kill).
11. SQLite: only the engine log is offered; Activity says it is not available for this connection.

## Filters and paging
12. Level chips debug / info / warn / error toggle (fatal rides with error, unknown is always shown); each chip is a command
    ("Toggle error entries") and re-queries.
13. From: 15 m, 1 h (default), 24 h, 7 d, Custom (date-time field); To: Now or Custom. Changing either re-queries.
14. Search (Ctrl+F ⌨): typing is debounced; plain text is sent as `q` (server filter); `/regex/`-style patterns filter
    client-side; matches are highlighted in the message and the expanded detail. Esc clears.
15. The status line shows `1,000 entries` (or `12 of 1,000`), **Load older** pages with the seq cursor until the start
    of the range; a capped source window shows "truncated".
16. ⌨ ↑/↓, PgUp/PgDn, Home/End move the selection; Enter expands (full message, detail, fields table, Copy); Esc collapses;
    Ctrl+C copies the selected entry as text; Ctrl+L clears the view; F5 refreshes; Wrap toggles line wrapping.

## Live tail
17. **Tail** (command "Toggle live tail") opens a `logs.tail` stream after the current page; new entries append and the
    list follows the bottom. Scrolling up stops following and shows **Jump to latest**.
18. ⌨ Space (in the list) pauses / resumes; paused streams catch up on resume (polled sources) or count drops (live sources).
19. Status line: `N entries · tailing · D dropped · E evicted`: dropped = engine-side queue drops (stream.state), evicted =
    entries removed from the 20,000-entry client buffer (oldest first).
20. Engine log: generate activity (open a console, run a query) → new engine lines appear within ~1 s.
21. Redis MONITOR: warning banner "MONITOR costs ~50 % throughput on busy servers"; after 10 minutes the engine stops it
    with a final "MONITOR stopped after 10 minutes" entry; **Extend 10 min** reopens it.
22. MongoDB change stream: insert/update/delete in `shop.orders` → entries appear live.
23. Closing the tab (or disconnecting the source client) ends the streams (`GET /streams` is empty).

## Export
24. Export ▾ → text / CSV / JSON. While tailing, the client buffer is exported (file name `logs-<source>-<time>.<ext>`).
    Otherwise the engine exports the current filter range (up to 100,000 entries, paging with `before`): desktop asks
    for a path and runs a job (toast with the path when done); browser downloads the file.
25. CSV opens in Excel with UTF-8 (BOM), multi-line details stay in one cell; cells starting with = + - @ are prefixed
    with ' (formula guard). JSON is an array of LogEntry; text lines indent detail and fields.

## Activity
26. **Activity** sub-view: polling every 2 s (`activity.poll`), paused while the tab or window is hidden ("paused while hidden").
27. Tiles: Sessions, Running, Blocked (with the head blocker), Longest running.
28. Grid columns per provider (id, user, host, app, database, state, duration, wait, blocked by, command, statement,
    cpu, reads); sort by clicking a header; idle sessions are dimmed; "↳ blocked by 57" on blocked rows; the head blocker
    row is marked and shows "blocks N".
29. SQL Server: open two consoles, `BEGIN TRAN; UPDATE …` in one and the same row in the other → the chain appears within
    2 s; **Locks** shows the lock summary rows (GRANT / WAIT).
30. **Only active** hides idle sessions but keeps idle blockers (PostgreSQL "idle in transaction" holding locks).
31. ⌨ Select a row → Delete (or **Kill…**) opens the typed confirmation: title "Kill session 57?", the exact statement
    (`KILL 57`, `ALTER SYSTEM KILL SESSION '123,4567' IMMEDIATE`, `SELECT pg_terminate_backend(4390)`,
    `CLIENT KILL ID 12`, `db.killOp(12345)`), the statement text; the danger button enables only after typing the id.
32. PostgreSQL: **Cancel query** (`pg_cancel_backend`) keeps the session; **Kill…** terminates it.
33. Read-only connections: Kill is disabled with "<connection> is read-only"; the engine answers 403 READ_ONLY anyway.
34. Missing kill privilege (SQL Server `app`): the error shows `GRANT ALTER ANY CONNECTION TO [app];`.
35. Enter / double-click (**Open in console**) opens a new console on the same connection with the statement.

## Code quality
36. Every action above is a registered command (`view.logs`, `logs.*`); Ctrl+K Ctrl+S lists the scoped keys (logs,
    logsList, logsActivity) without conflicts; no colours outside `theme/` (level badges use `--log-*` tokens).
37. Engine: `dotnet test engine/tests/DbStudio.Logs.Tests` (parsers per provider with recorded fixtures, golden SQL,
    FakeRespServer, Mongo/Kafka fakes, SQLite-backed runner and engine log tail, HTTP endpoints); Docker smoke
    (`ContainerSmokeTests`) runs SQL Server, PostgreSQL and Redis when Docker is available.
