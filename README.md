# DbStudio

DbStudio is a fast, keyboard-first desktop SQL client for **Microsoft SQL Server**, **Oracle** and **SQLite**,
for **Windows** and **macOS** (Apple Silicon and Intel).
It pairs a Monaco editor with schema-aware IntelliSense, streams result sets into a canvas grid that stays
smooth at hundreds of thousands of rows, and keeps every database driver out of the UI: a .NET 10 engine
runs as a local sidecar process and the React UI talks to it over authenticated HTTP and WebSocket.

## Features (M1)

- **Connections**: form-driven dialog per provider, Test Connection with server info, folders and colour
  tags (production = red), read-only connections enforced by the engine, passwords stored with Windows DPAPI or the macOS Keychain.
- **Object explorer**: databases/schemas, tables, views, procedures, functions, Oracle packages, sequences,
  synonyms, triggers; lazy loading, fuzzy filter, "Select top 1000", "Open DDL", drag a table into the editor.
- **SQL editor**: multi-tab, per-tab connection/database and transaction mode (Auto/Manual with Commit/Rollback),
  run statement at cursor, selection or whole script, destructive-statement guard (DELETE/UPDATE without WHERE,
  DROP, TRUNCATE).
- **IntelliSense**: context-aware completion for tables, columns, aliases, joins (FK-based join snippets),
  functions and packages; signature help, hover, go-to-definition (F12), live syntax diagnostics
  (ScriptDom for T-SQL, SQLite prepare, Oracle compile errors after CREATE).
- **Results**: one tab per result set plus Messages, streaming rows, type-aware formatting, NULL styling,
  client-side sort/filter, value viewer for long text/JSON/XML/binary, copy as TSV/CSV/JSON/Markdown/INSERT,
  export to CSV/JSON/SQL, cancel, elapsed time and row counts.
- **Oracle and SQL Server specifics**: DBMS_OUTPUT panel, PRINT/RAISERROR messages with click-to-line,
  `GO` batches, `EXEC` rewrite for SQL*Plus habits.
- **History** with full-text search and pinning; **session restore** of open tabs and unsaved text;
  light/dark themes following the OS; command palette.

## Architecture

```
+-----------------------------------------------------------------------------------+
| Electron main (desktop/)                                                          |
|  - spawns engine sidecar: DbStudio.Engine.exe --parent-pid <pid>                  |
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
|  platform/ adapter:               |        |  Providers: Sqlite | SqlServer | Oracle         |
|    electron | browser             |        |  TSql diagnostics (ScriptDom)                   |
+-----------------------------------+        |  SecretStore (DPAPI/Keychain), History, Settings|
                                             +----------------+--------------------------------+
                                                              | ADO.NET drivers
                                                              v
                                              SQL Server      Oracle          SQLite file
```

- The UI is identical in Electron and in a plain browser; only `ui/src/platform` differs.
- The engine listens on loopback only, requires a random bearer token (sent as a header, never in a URL) and
  allows CORS only from `dbstudio://app` (plus `http://localhost:5173` in `--dev`).
- The renderer is sandboxed (`contextIsolation`, `sandbox`, no Node), served from the privileged
  `dbstudio://app` origin with a strict CSP; the only bridge is `window.dbstudio`
  (contract: `ui/src/platform/bridge.ts`).
- If the engine dies, DbStudio offers to restart it and the UI reconnects with the new port/token.

The full design is in [docs/PLAN.md](docs/PLAN.md).

| Folder | What |
|---|---|
| `engine/` | .NET 10 solution (`DbStudio.slnx`): Core, Host (HTTP/WS API), providers, tests |
| `ui/` | React 18 + TypeScript + Vite renderer, IntelliSense in `src/intel`, editor in `src/editor` |
| `desktop/` | Electron shell: main process, preload, packaging (`electron-builder.yml`) |
| `scripts/` | `dev.ps1`, `build.ps1` (Windows installer), `build.sh` (macOS DMG), `stamp-version.ps1` |

## Prerequisites

- Windows 10/11 x64, or macOS 12+ (arm64 or x64) for development and macOS builds
- [.NET SDK 10](https://dotnet.microsoft.com/download) (`dotnet --version` >= 10.0)
- [Node.js 24](https://nodejs.org/) with npm
- Optional: Docker Desktop for the SQL Server and Oracle test databases

## Development

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
cd desktop; npm test                  # type-check, engine lifecycle tests, Electron smoke test
```

### Desktop environment variables

| Variable | Effect |
|---|---|
| `DBSTUDIO_DEV_URL` | Load the renderer from this localhost URL (Vite) instead of `dbstudio://app` |
| `DBSTUDIO_ENGINE_URL` + `DBSTUDIO_ENGINE_TOKEN` | Attach to an already running engine instead of spawning one |
| `DBSTUDIO_ENGINE_CMD` | Full command line used to start the engine (e.g. the fake engine) |
| `DBSTUDIO_ENGINE_PATH` | Path to a prebuilt engine exe (e.g. `engine/publish/DbStudio.Engine.exe`) |
| `DBSTUDIO_ENGINE_EXE` | Exe name inside `resources/engine` (default `DbStudio.Engine.exe`, then `DbStudio.Host.exe`; on macOS `DbStudio.Engine`, then `DbStudio.Host`) |
| `DBSTUDIO_ENGINE_TIMEOUT_MS` | READY handshake timeout (default 15 s; 180 s for `dotnet run`) |
| `DBSTUDIO_UI_DIR` | Folder served at `dbstudio://app` (default `ui/dist`, or `resources/ui` when installed) |
| `DBSTUDIO_DATA_DIR` | Data folder, for the shell and the engine (default: see [Where things live](#where-things-live)) |
| `DBSTUDIO_SECRET_STORE` | Engine password store: `dpapi`, `keychain`, `file` or `memory` (default: DPAPI on Windows, Keychain on macOS, `file` elsewhere) |

## Install on Windows / macOS

**Windows 10/11 (x64):** run `DbStudio-Setup-<version>.exe`. It installs per user (no admin rights needed) and lets
you pick the folder. The installer is not code-signed yet, so SmartScreen shows "Windows protected your PC": click
**More info**, then **Run anyway**.

**macOS 12+:** download the DMG for your Mac (`DbStudio-<version>-mac-arm64.dmg` for Apple Silicon M1/M2/M3/M4,
`...-mac-x64.dmg` for Intel; "About This Mac" shows which), open it and drag **DbStudio** to **Applications**. The
`.zip` holds the same app for scripted installs.

Builds without an Apple Developer ID are only ad-hoc signed and not notarized, so on first launch Gatekeeper says
"DbStudio cannot be opened because Apple cannot check it for malicious software" (or, for a downloaded file,
"is damaged and can't be opened"). Either:

- **Right-click (Control-click) DbStudio in Applications, choose Open, then Open again.** On macOS 15+, if there is
  no Open button: try to open the app once, then go to **System Settings > Privacy & Security** and click
  **Open Anyway** next to the DbStudio message. You only do this once per installed version.
- Or remove the quarantine flag in Terminal: `xattr -dr com.apple.quarantine /Applications/DbStudio.app`

Builds signed with a Developer ID and notarized (see [Signing](#signing-and-notarization-macos)) open without any of
this. DbStudio keeps running when you close its last window on macOS (click the Dock icon to get it back; Cmd+Q
quits). On macOS the SQL Server "Windows Authentication" option is labelled **Integrated (Kerberos)** and needs a
Kerberos ticket for your domain account (`kinit user@REALM`); SQL Login works everywhere.

## Building the installer

### Windows (NSIS)

```powershell
./scripts/build.ps1                  # -> desktop/dist/DbStudio-Setup-<version>.exe
./scripts/build.ps1 -SkipInstaller   # engine publish + UI build + desktop compile only
./scripts/build.ps1 -EngineOnly      # just the self-contained engine in engine/publish
./scripts/build.ps1 -Dir             # unpacked app in desktop/dist/win-unpacked
```

The build publishes the engine as a self-contained single-file `win-x64` executable
(`IncludeNativeLibrariesForSelfExtract`, so SqlClient's native SNI and SQLite ship inside it), builds the UI,
and packages both into an NSIS x64 installer with electron-builder. The target machine needs neither .NET
nor Node. The version comes from [`version.json`](version.json) and is injected at build time;
`./scripts/stamp-version.ps1 -Set 0.2.0` writes it into all three packages for a release commit.
The installer is not code-signed yet, so Windows SmartScreen will warn on first run.

### macOS (DMG + ZIP)

DMGs can only be built on a Mac (Xcode command-line tools: `xcode-select --install`), or by CI:

```bash
bash scripts/build.sh                    # -> desktop/dist/DbStudio-<version>-mac-{arm64,x64}.{dmg,zip}
bash scripts/build.sh --arch arm64       # one architecture only
bash scripts/build.sh --dir              # unpacked desktop/dist/mac-arm64/DbStudio.app, no DMG
bash scripts/build.sh --engine-only      # just the engines in engine/publish/osx-{arm64,x64}
```

The engine is published self-contained per architecture (`osx-arm64`, `osx-x64`) as a single-file
`DbStudio.Engine` with its native `libe_sqlite3.dylib` next to it (so it is signed with the app instead of being
extracted at run time). The script checks that the host-architecture engine starts, then electron-builder produces
one DMG and one ZIP per architecture with the engine in `DbStudio.app/Contents/Resources/engine/`. Separate
per-arch downloads were chosen over a universal app: the .NET single-file engine cannot be merged with `lipo`, so a
universal build would ship both engines and both Electron slices to everyone (about twice the size). The app uses
the hardened runtime with `desktop/build/entitlements.mac.plist` (JIT and unsigned executable memory for V8 and
the .NET runtime, library validation off for ad-hoc signatures). The icon (`desktop/build/icon.icns`) is generated
with `cd desktop; npm run icon`.

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

### CI

`.github/workflows/ci.yml` has two jobs. **Windows** (`windows-latest`) runs the engine, UI and desktop tests,
builds the NSIS installer and uploads it. **macOS** (`macos-latest`) runs the engine tests (including a real
Keychain round trip) and the desktop tests, then `scripts/build.sh` and uploads the arm64 and x64 DMGs and ZIPs.
Download them from the run's **Artifacts** section.

## Test databases (Docker)

SQLite needs nothing. For SQL Server and Oracle, the engine tests ship a compose file with the "shop" fixture
schema (see `engine/tests/docker/README.md`):

```powershell
docker compose -f engine/tests/docker/compose.yml up -d
# SQL Server 2022: localhost,1433  user sa       (password from the compose file)
# Oracle 23 Free:  localhost:1521  service FREEPDB1, user shop
$env:DBSTUDIO_IT='1'; dotnet test engine/DbStudio.slnx
```

Images: `mcr.microsoft.com/mssql/server:2022-latest` and `gvenzl/oracle-free:23-slim`. Without Docker the
integration tests are skipped and the rest of the suite still runs.

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
| Full screen | F11 |

Commit, Rollback and Toggle theme are in the Query and View menus and the command palette.
Ctrl+Enter and F5 belong to the editor; the menu shows them without registering them, so they never fire twice.

## Where things live

The data folder is `%APPDATA%\DbStudio` on Windows, `~/Library/Application Support/DbStudio` on macOS and
`$XDG_CONFIG_HOME/DbStudio` (default `~/.config/DbStudio`) on Linux; `DBSTUDIO_DATA_DIR` overrides it.

| What | Where (inside the data folder) |
|---|---|
| Saved connections, settings, query history | `connections.json`, `settings.json`, `history.db` |
| Saved passwords | Windows: `secrets.dat`, encrypted with DPAPI for the current Windows user (they do not roam to other machines or accounts). macOS: the login keychain, one "DbStudio" item per connection (Keychain Access shows them; they never touch the data folder). Linux: `secrets.aes.json`, AES-GCM with a key in `secrets.key` (mode 0600); this only keeps passwords out of plain files, it does not protect them from software running as you |
| Open tabs and unsaved editor text | `workspace.json` |
| Logs (engine output, startup errors) | `logs/` (Help > Open Logs Folder) |
| Electron profile (cache, window position) | `electron/` |

Uninstalling keeps the data folder; delete it by hand for a clean slate (on macOS also delete the "DbStudio"
items in Keychain Access).
