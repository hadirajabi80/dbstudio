# Work-package notes (Batch 3)

One file per work package of the Batch 3 plan (MySQL/MariaDB, ClickHouse, Snowflake, Elasticsearch, Cassandra):
`wp0.md` (foundation, read it first), then `WP-MY.md`, `WP-CH.md`, `WP-SF.md`, `WP-ES.md`, `WP-CS.md`, each written by its
work package. The orchestrator reads them at merge time.

## Ownership rules (summary)

- **R1** A WP creates files only under the paths of its "Owns" line (see `wp0.md`, "What each WP finds") and edits only
  (a) those files, (b) the blocks WP0 labelled for it in shared files:

  ```
  // WP-MY begin
  …
  // WP-MY end
  ```

  (one block per dialect per place; never touch a line outside your block, not even whitespace), (c) its own compose
  seed files and its own section of `engine/tests/docker/README.md`.
- **R2** Frozen for everyone except WP0 and the final integration pass: `ui/src/api/types.ts`, `client.ts`, `store/*`,
  `commands/*`, `components/Explorer/*`, `components/layout/*`, `app/*`, `Toolbar`, `StatusBar`, `editor/*`, `intel/*`
  (except your own dialect files), `format/index.ts|layout.ts`, `mocks/fixtures.ts|handlers.ts|engine.ts`,
  `package.json`, `Program.cs`, `Host.csproj`, `DbStudio.slnx`, `ModuleAssemblies.cs`, Core (except your labelled
  blocks), `ci.yml`, `release.yml`.
- **R4** Before handing in: `dotnet test engine/DbStudio.slnx -c Release` green with `DBSTUDIO_IT=0` plus your own
  integration tests against Docker; `npm run lint && npm run typecheck && npm test && npm run test:intel`;
  `npm run build && node .github/scripts/bundle-size.mjs --dist ui/dist --budget-kb 1400 --initial-kb 120` (print your
  initial delta: at most +1.5 KB gzipped per WP, D7); `docs/qa/<name>-walkthrough.md`.

## R3: requests for shared changes

A change you need in a file that R1 does not give you (a frozen file, a Core line outside your block, another WP's
file) is **not** made by you. Write it into your own notes file instead and carry on:

````markdown
## Requests

### R3-1 ui/src/components/Explorer/Explorer.tsx:212 — context menu id for relational rows
Reason: ClickHouse tables need `explorer.clickhouse.table` (Parts, Mutations) instead of `explorer.table`.
Proposed diff:
```diff
-  const menuId = row.kind === 'object' ? `explorer.${row.ref.type}` : …
+  const menuId = (row.kind === 'object' && objectMenuOverride?.(row)) || …
```
Local stub: `TODO(WPCH-shared)` in components/ClickHouse/commands.ts (the commands run from the palette meanwhile).
````

- file:line refers to the WP0 commit (`git log -1 --format=%h -- docs/wp-notes/wp0.md`); say which.
- Keep the proposed diff minimal and self-contained; the orchestrator applies requests at merge, in WP order.
- Never block on a request: stub locally behind a `TODO(WP<XX>-shared)` comment (e.g. `TODO(WPMY-shared)`), so the
  orchestrator can find every stub with one search once the shared change is in.
- Also record here anything another WP or the orchestrator must know (a deviation from the plan, a driver quirk, a
  publish-size delta, a test you skipped and why).
