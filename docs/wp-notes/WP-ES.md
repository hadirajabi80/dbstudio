# WP-ES — Elasticsearch / OpenSearch (notes for the orchestrator)

## Integration status (Batch 3 integration pass)

| Request | Status | Notes |
|---|---|---|
| R3-1 `'es.tasks'` stream kind | DONE | `api/types.ts`; the casts in `TasksView.tsx` and the mock pack are gone |
| R3-2 Docker Hub image | DONE | `engine/tests/docker/compose.yml` + README use `elasticsearch:8.15.3` (the CI integration job uses the compose file) |
| R3-3 optional OpenSearch CI job | DEFERRED | optional, needs the ~800 MB `opensearchproject/opensearch:2` image on every run; the suite still runs locally with `DBSTUDIO_ES_OPENSEARCH=1` |
| R3-4 mock server info | DONE | `mocks/m2/index.ts` (also reads `props.url` as the target) |

Branch `worktree-agent-af2d87bb6f7a9c803`, on WP0 `686056e`. Line numbers below refer to `686056e`.

## What landed

- **Engine** `engine/src/DbStudio.Sources.Elasticsearch/**`: `EsProvider` (`elasticsearch`, "Elasticsearch / OpenSearch",
  `SourceKind.Search`), `EsClient`, `EsSettings`, `EsTransport` (plain `HttpClient`, comma-separated URLs with failover
  sticky to the last good node; auth none / basic / apiKey / bearer; `tlsSkipVerify`; `caFile` custom root trust;
  `connectTimeout`), `EsErrors` (ES error body → `EngineException` with `EsErrorDetail { status, esType, rootCause }`),
  services (cluster, indices, search + documents, console, SQL + tasks, jobs) and `Endpoints/EsEndpoints.cs`
  (`/api/v1/es/{cid}/…`, the list is in `ui/src/api/types.es.ts` and `ui/src/api/m3/es.ts`), stream factory `es.tasks`,
  jobs `es.reindex`, `es.import`, `es.export`. Flavor detected from `GET /` (or forced by the `flavor` field).
- **Tests** `engine/tests/DbStudio.Sources.Elasticsearch.Tests/**`: 84 unit/endpoint tests over a fake ES (TestServer like
  Kafka) + 12 live (6 Elasticsearch 8.15.3, 6 OpenSearch 2 behind `DBSTUDIO_ES_OPENSEARCH=1` / `DBSTUDIO_OS_URL`).
- **Seed** `engine/tests/docker/seed-elasticsearch.sh` + `.ndjson` (852 KB): `shop-customers`, `shop-products`,
  `shop-orders` (+ alias `shop-sales`) with the seed-mongo.js data (same PRNG, Persian names); README section appended.
- **UI** `ui/src/components/Elasticsearch/**` (source module, tree, menus, lazy views and dialogs), `ui/src/es/**` (pure
  logic: console parser, DSL completion, JSON, grid, aggregations; `es/mock/*` = the in-memory cluster of the mock),
  `api/m3/es.ts`, `api/types.es.ts`, `mocks/packs/elasticsearch.ts` (provider + connection **active**: `c_es`
  "Elasticsearch Dev", folder "Batch 3"; `connections` is a getter returning fresh copies so tests can flip `readOnly`).
- **Docs** `docs/qa/elasticsearch-walkthrough.md`.

## Measurements

- Initial load: 1566.4 → **1567.4 KB** gzipped, **+1.0 KB** (1,067 bytes, ≤ 1.1 KB); whole bundle 2130.0 → 2188.0 KB (+58 KB, all lazy). Breakdown (gzip -9 per file):
  `client` +448 (api/m3/es.ts), `menuModel` split out of `Menu` +220 net (see note 1), `index` +130 (commands glob entry,
  lazy-chunk map), shared icon chunks `import`/`hash` +450, `square-terminal`/`layout-list` −181.
- Lazy: `EsView` chunk ≈ 72 KB raw, ES dialogs ≈ 22 KB, `es` logic ≈ 11 KB, `monacoEditor` (ES) ≈ 13 KB, `es.css` 20 KB.
- Engine publish delta: none expected (no packages; one small assembly).

## Notes for other WPs / the orchestrator

1. **`registerContextMenu` costs ~0.2–0.25 KB initial for the first WP that calls it** from a lazy `commands.ts`: the
   import makes rolldown split `commands/menuModel` out of the shell's `Menu` chunk. Paid once for the batch (later
   callers are free). A dynamic `import()` of menuModel does not avoid it (measured).
2. **Icons**: a lucide icon used both by the shell's initial chunks (e.g. `commandMenu` ICONS: Search, TableProperties,
   ArrowRightLeft, Rows3, Activity) and by a lazy chunk becomes its own initial chunk (~0.2 KB each). WP-ES uses
   icons the shell does not (TextSearch, FileSpreadsheet, Languages, ChartLine) or icons that already have a shared chunk.
   Command `icon:` strings are unaffected.
3. Document ids with `/` travel as `%2F` (engine decodes like Kafka's `Segment`). A missing document is `200 found:false`;
   a stale optimistic-concurrency write is **409** `PROVIDER_ERROR` with `detail.esType = version_conflict_engine_exception`.
4. OpenSearch SQL quotes identifiers with backticks, Elasticsearch SQL with double quotes; the SQL tab adapts its
   default query and hint to the detected flavor.
5. `_cat/indices` counts nested docs (6,860 for `shop-orders`); the engine reports top-level counts (2,000).

## Deviations from the plan

- `Catalog/es-api.json` (plan: engine): the console's endpoint catalog for completion is UI-side
  (`ui/src/es/apiCatalog.ts`, lazy); the engine keeps the read-only classification of console requests in C#.
- No import-preview endpoint: the import dialog previews the picked file client-side.
- Tasks view polls through the `es.tasks` stream (live while visible) and refreshes on demand.
- The mock's source-client `ServerInfo` stays "Mock elasticsearch" (mocks/m2/index.ts is not WP-ES's file, R3-4).

## Requests

### R3-1 ui/src/api/types.ts:702 — stream kind `es.tasks`
Reason: the Tasks view and the mock open an `es.tasks` stream; the union does not list it (cast meanwhile).
Proposed diff:
```diff
   // Find in database (api/types.search.ts)
-  | 'db.search';
+  | 'db.search'
+  // Batch 3 WP-ES (api/types.es.ts EsTasksStreamItem)
+  | 'es.tasks';
```
Local stubs: `TODO(WPES-shared)` in `ui/src/components/Elasticsearch/TasksView.tsx` (`'es.tasks' as StreamKind`); the
same cast in `ui/src/mocks/packs/elasticsearch.ts` can then go.

### R3-2 engine/tests/docker/compose.yml:277 (and the CI integration job) — image registry
Reason: `docker.elastic.co` was unreachable from this machine while Docker Hub's identical `elasticsearch:8.15.3`
worked; the live tests already fall back to it (`DBSTUDIO_ES_IMAGE` overrides). Consider switching compose/CI:
```diff
-    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.3
+    image: elasticsearch:8.15.3
```

### R3-3 .github/workflows/ci.yml — optional OpenSearch live run (not required)
Reason: the OpenSearch suite runs only with `DBSTUDIO_ES_OPENSEARCH=1`; an optional job (or `env` on the integration job)
would exercise it in CI. Needs `opensearchproject/opensearch:2` (~800 MB).

### R3-4 ui/src/mocks/m2/index.ts:184 — mock server info for Elasticsearch (cosmetic)
```diff
+  if (providerId === 'elasticsearch') return { version: 'Elasticsearch 8.15.3 (cluster rowlit-dev, green, 3 nodes)', productVersion: '8.15.3', serverName: 'rowlit-dev', user: null, database: null };
   return { version: `Mock ${providerId}`, productVersion: null, serverName: target, user: null, database: null };
```
(`target` also reads `props.url` for elasticsearch: `conn.props.host ?? conn.props.uri ?? conn.props.bootstrapServers ?? conn.props.url`.)

## Known gaps

- Not live-tested: TLS with a CA file, API key / bearer auth (fake server only), multi-node failover.
- CSV export takes its columns from the first 1,000 documents (plus `fields` when given).
- The reindex job leaves its result document in the cluster's `.tasks` index (as Kibana does).
- Index detail of an alias or pattern shows the first matching concrete index.
- Document grid pages with from/size (≤ 10,000, `index.max_result_window`); the search API supports `search_after`.
- Console bodies: `//` and `/* */` comments and trailing commas are stripped before sending (Kibana-like); other
  non-JSON text is sent as typed and Elasticsearch answers with its parse error.
