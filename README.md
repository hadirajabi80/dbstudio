<p align="center">
  <img src="desktop/build/icons/rowlit.svg" width="112" height="112" alt="Rowlit">
</p>

<h1 align="center">Rowlit</h1>

<p align="center"><strong>See your data in a better light.</strong><br>
A fast, keyboard-first desktop database client for Windows and macOS.</p>

<p align="center">
  <a href="https://github.com/hadirajabi80/rowlit/releases/latest"><b>Download for Windows</b></a> ·
  <a href="https://github.com/hadirajabi80/rowlit/releases/latest"><b>Download for macOS</b></a> ·
  <a href="https://github.com/hadirajabi80/rowlit/releases">All releases</a>
</p>

**Microsoft SQL Server**, **Oracle**, **PostgreSQL** and **SQLite**, plus workspaces for **Redis**, **MongoDB** and
**Kafka**, in one app. Rowlit pairs a Monaco editor with schema-aware IntelliSense, streams result sets into a canvas
grid that stays smooth at hundreds of thousands of rows, and keeps every database driver out of the UI: a .NET 10
engine runs as a local sidecar and the React UI talks to it over authenticated HTTP and WebSocket.

> **Coming from DbStudio?** Rowlit is the new name of DbStudio (1.1.0 and earlier). Installing Rowlit, or letting
> DbStudio update itself, replaces the old app in place; your connections, saved passwords, settings, history,
> diagrams and open tabs carry over automatically.

## Features

### Databases

- **SQL Server, Oracle, PostgreSQL, SQLite**: explorer for databases, schemas, tables, views, routines, packages,
  sequences, synonyms, triggers and types, with lazy loading, fuzzy filter, "Select top 1000" and "Open DDL".
- **Redis** (standalone, cluster, sentinel, TLS): key browser with a folder tree and TTL countdown, an editor per
  type (strings with JSON/hex views, hashes, lists, sets, sorted sets, streams, ReJSON), workbench, CLI, Pub/Sub,
  slowlog, info dashboard and memory analysis.
- **MongoDB** (URI and SRV, replica sets, Atlas): documents as list, JSON or table with Extended JSON round trips,
  filter/projection/sort completion, aggregation builder with per-stage previews and code export, schema analysis,
  indexes, validation rules, explain, import and export.
- **Kafka** (PLAINTEXT, SASL, SSL, Schema Registry): topics, partitions and configs, a message browser by offset or
  time with JSON, Avro and Protobuf decoders, live tail, produce, consumer groups with lag and offset reset.
- **Several connections at once**: colour-coded connections (production = red), read-only connections enforced by
  the engine, an *Active connections* panel and **Run on multiple connections** with results grouped per connection.

### Writing SQL

- **IntelliSense** for tables, columns, aliases, FK-based joins, functions and packages, **schemas and databases**
  (also after `USE`), with signature help, hover, go to definition (F12) and live diagnostics.
- **Editor**: per-tab connection and database, auto or manual transactions, run statement, selection or script,
  destructive-statement guard, parameters, snippets, the SQL formatter and query plans (estimated and actual).
- **Split editor groups**: drag tabs between groups, split side by side or stacked, or **detach a tab into its own
  window** and move it back.
- **Edit database objects** in place: Ctrl+S saves the **whole** procedure, function, view or trigger to the server,
  with *Compare with server* before you do.
- **Execute procedures and functions** without opening them: typed inputs, NULL/Default toggles, validation and a
  live preview; results open on a full-page result view with **OUT parameters and the return value as a card**.

### Exploring data

- **Results grid** streaming hundreds of thousands of rows: sort, filter, value viewer, right-to-left text, copy as
  TSV/CSV/JSON/Markdown/INSERT, export to CSV, JSON, SQL and **Excel (.xlsx)** with typed cells and a frozen header.
- **Find in database** (Ctrl+Shift+F): a centred popup that searches object names, columns and code (procedures,
  functions, views, triggers) as you type, and optionally table data, across all connections or just the connection,
  database, schema or tables selected in the explorer; results stream in grouped by object with a preview of the
  match, ↑/↓ and Enter open them at the line, and *Open in tab* keeps them next to your other tabs.
- **Objects tab**: a permanent first tab, like Navicat's, that follows the explorer selection: a connection's
  databases or schemas as cards, a schema's tables (or views, procedures, functions when you pick that folder) with
  type filters, live search, counts and stats (rows, size, modified, comment), with list, card and small-icon views.
  It can be turned off in Settings › General.
- **Saved queries** per schema (Ctrl+Alt+S): a **Queries** folder under every schema and in the Objects tab; open a
  saved query and Ctrl+S updates it in place; rename, duplicate, delete, and find them with Ctrl+P (`q:`).
- **Dependencies** in every object tab: what it **uses** and what it is **used by**, with click-through and
  "Open in ER diagram".
- **ER diagrams** per schema, per selection or around a table, smooth with 500+ tables, crow's-foot edges, PNG/SVG
  export; relationships also show up on old or permission-restricted SQL Server databases.
- **Table designer** with DDL preview, and **code generation** for C#, Go, TypeScript, Java, Python and Prisma.
- **Logs & activity**: server logs per provider, sessions, operations, locks and blocking chains with Kill, side by
  side with your queries.

### The app

- **Keyboard first**: every action is in the command palette (Ctrl+Shift+P), Ctrl+P goes to any object, F1 opens
  the searchable shortcut sheet; shortcuts follow the platform (Ctrl on Windows, ⌘ on macOS).
- **7 app colour themes** (Light, Paper, Solarized Light, Dark, Midnight, Nord, Violet) and **11 code themes**,
  chosen independently; a redesigned, searchable **Settings** dialog.
- **Updates itself**: update status and download progress in the status bar, *Check for updates* in Settings and a
  notification when a new version is ready (Windows installs it on restart; macOS tells you when one is available).
- History with full-text search, session restore of open tabs and unsaved text, a welcome screen with a sample
  database, and crash isolation: one failing panel never takes the window down.

## Install

| Platform | File on the [latest release](https://github.com/hadirajabi80/rowlit/releases/latest) |
|---|---|
| Windows 10/11 (x64) | `Rowlit-Setup-<version>.exe` |
| macOS 12+, Apple Silicon (M1–M4) | `Rowlit-<version>-mac-arm64.dmg` |
| macOS 12+, Intel | `Rowlit-<version>-mac-x64.dmg` |

**Windows:** run the installer. It installs per user (no admin rights) and lets you pick the folder. It is not
code-signed yet, so SmartScreen shows "Windows protected your PC": click **More info**, then **Run anyway**.

**macOS:** open the DMG and drag **Rowlit** to **Applications** (the `.zip` holds the same app for scripted
installs). Builds without an Apple Developer ID are only ad-hoc signed, so on first launch Gatekeeper says the app
"cannot be opened" or "is damaged". Either right-click (Control-click) Rowlit in Applications and choose **Open**
twice (macOS 15+: open it once, then **System Settings > Privacy & Security > Open Anyway**), or run
`xattr -dr com.apple.quarantine /Applications/Rowlit.app`. If you had DbStudio, drag **DbStudio** from Applications
to the Trash after Rowlit has started once; your data has moved to Rowlit.

Rowlit keeps running when you close its last window on macOS (click the Dock icon to get it back; ⌘Q quits). On
macOS the SQL Server "Windows Authentication" option is labelled **Integrated (Kerberos)** and needs a Kerberos
ticket (`kinit user@REALM`); SQL Login works everywhere.

## Architecture

```
+-----------------------------------------------------------------------------------+
| Electron main (desktop/)                                                          |
|  - spawns engine sidecar: Rowlit.Engine.exe --parent-pid <pid>                    |
|  - reads one stdout line:  DBSTUDIO_READY {"port":51234,"token":"<32B base64url>"}|
|  - registers dbstudio:// scheme -> serves ui/dist (origin dbstudio://app)         |
|  - preload exposes window.dbstudio { getEngineInfo(), showSaveDialog(), ... }     |
+------------------+--------------------------------------------------+-------------+
                   | IPC (contextBridge)                              | stdin/stdout, kill on exit
                   v                                                  v
+-----------------------------------+        +-------------------------------------------------+
| Renderer: React + TS + Vite (ui/) |  HTTP  | .NET 10 engine (engine/)                        |
|  Zustand stores                   |<------>| ASP.NET Core minimal API on 127.0.0.1:<random>  |
|  Monaco editor                    |  REST  |  Authorization: Bearer <token> on every request |
|  sql-intel (TS completion engine, |        |                                                 |
|    runs in renderer over cached   |  WS    |  SessionManager  -> one DbConnection per tab    |
|    CatalogSnapshot)               |<------>|  CatalogService  -> per-connection cache        |
|  glide-data-grid results          | events |  ExecutionService-> streams rows over WS        |
|  platform/ adapter:               |        |  Providers: Sqlite | SqlServer | Oracle | PgSql |
|    electron | browser             |        |  Sources: Redis | MongoDB | Kafka (+ streams)  |
|                                   |        |  TSql diagnostics (ScriptDom), Logs, Diagrams   |
+-----------------------------------+        |  SecretStore (DPAPI/Keychain), History, Settings|
                                             +----------------+--------------------------------+
                                                              | ADO.NET drivers, StackExchange.Redis,
                                                              | MongoDB.Driver, Confluent.Kafka
                                                              v
                       SQL Server   Oracle   PostgreSQL   SQLite file   Redis   MongoDB   Kafka
```

- The UI is identical in Electron and in a plain browser; only `ui/src/platform` differs.
- The engine listens on loopback only, requires a random bearer token (sent as a header, never in a URL) and
  allows CORS only from `dbstudio://app` (plus `http://localhost:5173` in `--dev`).
- The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node), served from the privileged
  `dbstudio://app` origin with a strict CSP; the only bridge is `window.dbstudio`
  (contract: `ui/src/platform/bridge.ts`).
- If the engine dies, Rowlit offers to restart it and the UI reconnects with the new port/token.
- Internal identifiers (the `DbStudio.*` .NET projects, the `dbstudio://` scheme, `window.dbstudio`, IPC channels,
  `DBSTUDIO_*` variables) keep their historical names on purpose.

The full design is in [docs/PLAN.md](docs/PLAN.md).

| Folder | What |
|---|---|
| `engine/` | .NET 10 solution (`DbStudio.slnx`): Core, Host (HTTP/WS API), SQL providers, `Sources.{Redis,Mongo,Kafka}`, `Logs`, tests |
| `ui/` | React + TypeScript + Vite renderer, IntelliSense in `src/intel`, editor in `src/editor` |
| `desktop/` | Electron shell: main process, preload, packaging (`electron-builder.yml`), app icons (`build/`) |
| `scripts/` | `dev.ps1`, `build.ps1` (Windows installer), `build.sh` (macOS DMG), `stamp-version.ps1` |

## Development

Prerequisites: Windows 10/11 x64 (or macOS 12+ for macOS builds), [.NET SDK 10](https://dotnet.microsoft.com/download),
[Node.js 24](https://nodejs.org/) with npm, and optionally Docker Desktop for the sample and test databases.

```powershell
./scripts/dev.ps1            # engine (--dev, port 5121) + Vite (5173, hot reload) + Electron
./scripts/dev.ps1 -Browser   # engine + Vite only; open http://localhost:5173
```

`dev.ps1` installs npm dependencies on first run, waits for the engine health check, and stops every
process it started when you press Ctrl+C or close the window. Renderer changes hot-reload; changes to
`desktop/src` need a restart of the script.

Individual pieces:

```powershell
# Engine only (dev mode: fixed token, CORS for the Vite origin)
dotnet run --project engine/src/DbStudio.Host -- --dev --port 5121 --token dev-token
curl -H "Authorization: Bearer dev-token" http://127.0.0.1:5121/api/v1/health

# UI against the dev engine, or fully mocked (MSW, no engine)
cd ui; $env:VITE_ENGINE_URL='http://127.0.0.1:5121'; $env:VITE_ENGINE_TOKEN='dev-token'; npm run dev
cd ui; npm run dev:mock

# Electron with its own engine (dotnet run) and the built UI (ui/dist)
cd desktop; npm start

# Electron against a fake engine (no .NET needed); extra args go to the fake engine
cd desktop; npm run start:fake
cd desktop; npm run start:fake -- --exit-after 5000     # see the restart dialog
```

Tests:

```powershell
dotnet test engine/DbStudio.slnx      # engine (Docker-backed tests skip without Docker)
cd ui; npm test                       # vitest
cd desktop; npm test                  # type-check, engine lifecycle and data-folder tests, Electron smoke test
```

### Desktop environment variables

| Variable | Effect |
|---|---|
| `DBSTUDIO_DEV_URL` | Load the renderer from this localhost URL (Vite) instead of `dbstudio://app` |
| `DBSTUDIO_ENGINE_URL` + `DBSTUDIO_ENGINE_TOKEN` | Attach to an already running engine instead of spawning one |
| `DBSTUDIO_ENGINE_CMD` | Full command line used to start the engine (e.g. the fake engine) |
| `DBSTUDIO_ENGINE_PATH` | Path to a prebuilt engine exe (e.g. `engine/publish/Rowlit.Engine.exe`) |
| `DBSTUDIO_ENGINE_EXE` | Exe name inside `resources/engine` (default `Rowlit.Engine.exe`, then `DbStudio.Engine.exe`, `DbStudio.Host.exe`; on macOS the same names without `.exe`) |
| `DBSTUDIO_ENGINE_TIMEOUT_MS` | READY handshake timeout (default 15 s; 180 s for `dotnet run`) |
| `DBSTUDIO_UI_DIR` | Folder served at `dbstudio://app` (default `ui/dist`, or `resources/ui` when installed) |
| `DBSTUDIO_DATA_DIR` | Data folder, for the shell and the engine (default: see [Where things live](#where-things-live)) |
| `DBSTUDIO_SECRET_STORE` | Engine password store: `dpapi`, `keychain`, `file` or `memory` (default: DPAPI on Windows, Keychain on macOS, `file` elsewhere) |

## Building the installer

### Windows (NSIS)

```powershell
./scripts/build.ps1                  # -> desktop/dist/Rowlit-Setup-<version>.exe
./scripts/build.ps1 -SkipInstaller   # engine publish + UI build + desktop compile only
./scripts/build.ps1 -EngineOnly      # just the self-contained engine in engine/publish
./scripts/build.ps1 -Dir             # unpacked app in desktop/dist/win-unpacked
```

The build publishes the engine as a self-contained single-file `win-x64` executable, `Rowlit.Engine.exe`
(`IncludeNativeLibrariesForSelfExtract`, so SqlClient's native SNI and SQLite ship inside it), builds the UI,
and packages both into an NSIS x64 installer with electron-builder. The target machine needs neither .NET
nor Node. The version comes from [`version.json`](version.json) and is injected at build time;
`./scripts/stamp-version.ps1 -Set 0.2.0` writes it into all three packages for a release commit.
The installer is not code-signed yet, so Windows SmartScreen will warn on first run.

The installer keeps the `appId` (`com.dbstudio.desktop`) and NSIS GUID of DbStudio, so it upgrades an installed
DbStudio in place: the old app, its folder and its shortcuts are removed and Rowlit is installed in
`%LOCALAPPDATA%\Programs\Rowlit` (`desktop/build/installer.nsh`). Never change either value.

### macOS (DMG + ZIP)

DMGs can only be built on a Mac (Xcode command-line tools: `xcode-select --install`), or by CI:

```bash
bash scripts/build.sh                    # -> desktop/dist/Rowlit-<version>-mac-{arm64,x64}.{dmg,zip}
bash scripts/build.sh --arch arm64       # one architecture only
bash scripts/build.sh --dir              # unpacked desktop/dist/mac-arm64/Rowlit.app, no DMG
bash scripts/build.sh --engine-only      # just the engines in engine/publish/osx-{arm64,x64}
```

The engine is published self-contained per architecture (`osx-arm64`, `osx-x64`) as a single-file
`Rowlit.Engine` with its native `libe_sqlite3.dylib` next to it (so it is signed with the app instead of being
extracted at run time). The script checks that the host-architecture engine starts, then electron-builder produces
one DMG and one ZIP per architecture with the engine in `Rowlit.app/Contents/Resources/engine/`. Separate
per-arch downloads were chosen over a universal app: the .NET single-file engine cannot be merged with `lipo`, so a
universal build would ship both engines and both Electron slices to everyone (about twice the size). The app uses
the hardened runtime with `desktop/build/entitlements.mac.plist` (JIT and unsigned executable memory for V8 and
the .NET runtime, library validation off for ad-hoc signatures).

From Windows you can still cross-publish and smoke-check the macOS engines:
`./scripts/build.ps1 -EngineOnly -Runtime osx-arm64` (and `osx-x64`); electron-builder itself refuses to package
macOS apps on Windows.

#### Signing and notarization (macOS)

| Environment | Result |
|---|---|
| nothing set (default) | ad-hoc signature (`-c.mac.identity=-`): runs on any Mac after the Gatekeeper step above |
| `CSC_LINK` (path or base64 of a "Developer ID Application" `.p12`) + `CSC_KEY_PASSWORD`, or `CSC_NAME` (certificate already in your keychain) | signed with your Developer ID |
| plus `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` (or `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`) | also notarized and stapled: opens with no warning |

Create the app-specific password at appleid.apple.com. In CI, set the repository secrets `MAC_CSC_LINK`
(base64 of the `.p12`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`;
without them the macOS job produces ad-hoc signed DMGs.

### App icon

The icon master is `desktop/build/icons/rowlit.svg` (plus `rowlit-macos.svg` on Apple's icon grid and the
pixel-hinted `rowlit-small.svg`). `cd desktop; npm run icon` renders `build/icon.png`, `build/icon.ico`
(16–256 px), `build/icon.icns` (16–1024 px) and `ui/public/favicon.svg` from the same shapes, with no image
libraries. In the app the mark is drawn by `ui/src/theme/brand/RowlitMark.tsx` from the `--brand-mark-*` tokens.

### CI

`.github/workflows/ci.yml` has two jobs. **Windows** (`windows-latest`) runs the engine, UI and desktop tests,
builds the NSIS installer and uploads it. **macOS** (`macos-latest`) runs the engine tests (including a real
Keychain round trip) and the desktop tests, then `scripts/build.sh` and uploads the arm64 and x64 DMGs and ZIPs.
Download them from the run's **Artifacts** section. Pushing a `v<version>` tag runs `release.yml`, which publishes
the installers, `latest.yml` / `latest-mac.yml` and the release notes from `docs/release-notes/`.

## Sample and test databases (Docker)

SQLite needs nothing (File > Open the sample database). For everything else, `engine/tests/docker/compose.yml`
(compose project `dbstudio-it`) starts seeded sample servers with the "shop" data, which are also what the
integration tests run against (details and seeds in `engine/tests/docker/README.md`):

```powershell
docker compose -f engine/tests/docker/compose.yml up -d                     # SQL Server, Oracle, PostgreSQL, Redis, MongoDB
docker compose -f engine/tests/docker/compose.yml --profile kafka up -d     # + Kafka and Schema Registry
```

| Server | Connect Rowlit to | Credentials |
|---|---|---|
| SQL Server 2022 | `localhost,14333`, database `shop` | `sa` / `DbStudio_Dev_2026!` |
| Oracle 23 Free | `localhost:15211`, service `FREEPDB1` | `shop` / `shop` |
| PostgreSQL 17 | `localhost:15432`, database `shop` | `shop` / `shop` |
| Redis Stack 7.4 | `localhost:16379` (RedisInsight on `:18001`) | none |
| MongoDB 7 (replica set) | `mongodb://localhost:27018/?directConnection=true` | none |
| Kafka 3.8 (KRaft) | `localhost:19092`, Schema Registry `http://localhost:18081` | none |

```powershell
$env:DBSTUDIO_IT='1'; dotnet test engine/DbStudio.slnx    # Docker suites: Testcontainers, or the servers above via env vars
```

Images: `mcr.microsoft.com/mssql/server:2022-latest`, `gvenzl/oracle-free:23-slim`, `postgres:17`,
`redis/redis-stack:7.4.0-v1`, `mongo:7`, `apache/kafka:3.8.0`, `confluentinc/cp-schema-registry:7.7.1`. Without
Docker (or with `DBSTUDIO_IT=0`) the integration tests are skipped and the rest of the suite still runs.

## Keyboard shortcuts

| Action | Shortcut |
|---|---|
| Execute statement at cursor / selection | Ctrl+Enter |
| Execute script | F5 |
| Cancel execution | Shift+F5 |
| New query tab | Ctrl+N |
| New connection | Ctrl+Shift+N |
| Open file / Save / Save as | Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Close tab | Ctrl+W |
| Command palette | Ctrl+Shift+P |
| Toggle object explorer | Ctrl+B |
| Toggle results pane | Ctrl+R |
| Query history | Ctrl+Shift+H |
| Go to definition | F12 / Ctrl+click |
| Trigger completion / parameter hints | Ctrl+Space / Ctrl+Shift+Space |
| Zoom in / out / reset | Ctrl+= / Ctrl+- / Ctrl+0 |
| Full screen | F11 (macOS: Ctrl+⌘F) |
| Go to object | Ctrl+P |
| Keyboard shortcuts | F1 / Ctrl+K Ctrl+S |
| Change connection / database | Ctrl+Shift+K / Ctrl+Shift+D |
| Run on multiple connections | Ctrl+Alt+Enter |
| Reopen closed tab / switch tabs | Ctrl+Shift+T / Ctrl+Tab, Ctrl+1…9 |
| Maximize results | Ctrl+Shift+R |
| Find in database (scope = explorer selection) | Ctrl+Shift+F |
| Settings | Ctrl+, |
| ER diagram | Ctrl+Alt+E |
| Logs & activity | Ctrl+Alt+Shift+L |

On macOS every Ctrl shortcut above uses ⌘ (Cmd). The shortcut sheet (F1) always shows the complete, current list.

Commit, Rollback and Toggle theme are in the Query and View menus and the command palette.
Ctrl+Enter and F5 belong to the editor; the menu shows them without registering them, so they never fire twice.

## Where things live

The data folder is `%APPDATA%\Rowlit` on Windows, `~/Library/Application Support/Rowlit` on macOS and
`$XDG_CONFIG_HOME/Rowlit` (default `~/.config/Rowlit`) on Linux; `DBSTUDIO_DATA_DIR` overrides it.

On its first start Rowlit moves an existing DbStudio folder (`%APPDATA%\DbStudio`, `~/Library/Application
Support/DbStudio`) to this location in one step, and re-points the sample database connection. If DbStudio is still
running the move waits for the next start; nothing is copied half-way or deleted (`desktop/src/main/data-dir.ts`).

| What | Where (inside the data folder) |
|---|---|
| Saved connections, settings, query history | `connections.json`, `settings.json`, `history.db` |
| Saved data filters, ER diagram layouts | `filters.json`, `diagrams.json` |
| Saved passwords | Windows: `secrets.dat`, encrypted with DPAPI for the current Windows user (they do not roam to other machines or accounts). macOS: the login keychain, one item per connection under the service name "DbStudio" (kept from before the rename, so existing passwords stay readable; Keychain Access shows them). Linux: `secrets.aes.json`, AES-GCM with a key in `secrets.key` (mode 0600); this only keeps passwords out of plain files, it does not protect them from software running as you |
| Open tabs and unsaved editor text | `workspace.json` |
| Logs (engine output, startup errors) | `logs/` (Help > Open Logs Folder) |
| Electron profile (cache, window position) | `electron/` |

Uninstalling keeps the data folder; delete it by hand for a clean slate (on macOS also delete the "DbStudio"
items in Keychain Access).
