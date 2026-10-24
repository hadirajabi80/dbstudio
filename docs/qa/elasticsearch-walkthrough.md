# Elasticsearch / OpenSearch walkthrough (WP-ES, plan-batch3)

Pass/fail per step. Run in both themes and at 150 % app zoom. Keyboard-only steps are marked ⌨.

## Setup
- Real cluster: `docker compose -f engine/tests/docker/compose.yml --profile search up -d` (Elasticsearch 8.15.3 on
  `http://localhost:19200`, security off; the one-shot `elasticsearch-seed` loads `shop-customers` (200, incl. Persian
  names), `shop-products` (50), `shop-orders` (2,000, `items` nested, alias `shop-sales`)). If `docker.elastic.co` is
  unreachable use the Docker Hub image `elasticsearch:8.15.3`. Re-seed by hand: `ES_URL=http://localhost:19200 sh
  engine/tests/docker/seed-elasticsearch.sh`.
- OpenSearch: `docker run -d -p 19201:9200 -e discovery.type=single-node -e DISABLE_SECURITY_PLUGIN=true
  -e OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m" opensearchproject/opensearch:2`, then run the seed script with
  `ES_URL=http://localhost:19201`.
- No Docker: `npm run dev:mock` → connection **Elasticsearch Dev** (`c_es`, folder "Batch 3"): cluster `rowlit-dev`, 3
  nodes (one at 83 % heap), the shop indices, the hidden data stream `logs-app-default`, templates `logs-app`
  (composable), `logs-mappings` (component), `shop-template` (legacy), a running update-by-query task.

## Connect
1. New connection → Elasticsearch / OpenSearch. `URL` is required (comma list for several nodes). Authentication None /
   User and password / API key (encoded key or `id:api_key`) / Bearer token show only their fields; secrets are kept in
   the OS secret store, never in `connections.json`. TLS: Skip verification, CA certificate (file). Flavor Detect /
   Elasticsearch / OpenSearch. The suggested name is the host of the first URL.
2. **Test** → `Elasticsearch 8.15.3 (cluster docker-cluster, green, 1 node)` (OpenSearch: `OpenSearch 2.x …`). A wrong
   port fails within the connect timeout with "Cannot reach …"; a wrong password with a PRIVILEGE/401 message.
3. Connect opens **Cluster overview**.

## Explorer and overview
4. Connection → Overview, Dev Tools, SQL, Indices (count) → indices with `docs · size` and a health-coloured icon,
   Aliases → `shop-sales → shop-orders`, Data streams, Templates, Nodes (crown on the elected master), Tasks.
5. Hidden/system indices are not listed; Ctrl+Shift+P → "Show hidden and system indices" (or the checkbox of Indices)
   lists `.ds-logs-app-default-…` (chip with the data stream) and system indices.
6. Context menus: index → Browse documents, Search, Open in Dev Tools, Mappings, Index settings, Aliases, Shards,
   Statistics, Export…, Import…, Reindex…, Add alias…, Refresh, Flush, Force merge…, Close index… / Open index, Delete
   index… (danger); alias → Browse, Search, Dev Tools, Export, Remove alias…; folders → overview, Dev Tools, SQL, Tasks,
   Create index…, Import…, Reindex…, hidden toggle, refresh.
7. Overview: health banner (green/yellow/red with the reason), tiles (nodes, indices, documents, store, primary shards,
   unassigned shards in warning/danger colours, JVM heap, disk, pending tasks), nodes table with role chips and
   heap/RAM/disk meters (warning ≥ 75 %, danger ≥ 90 %), largest indices as bars (click opens the index).
8. ⌨ Ctrl+P `t:shop` lists the indices and the alias of every loaded connection; Enter opens the index.

## Documents
9. Index tab → Documents: grid (columns = flattened `_source`, `address.city` etc.), 50 rows, `1–50 of 200`, pager,
   rows 25/50/100/200. Persian names render right-to-left in the grid and the record panel.
10. Lucene box: `tier:gold AND address.city:Tehran`, `total:>500`, `name:رضایی`, `"living room"`, `sku:SKU-00*` → Apply.
    Click a column header to sort (text fields use their `.keyword`; "not sortable" otherwise).
11. Select a row: the record panel shows `_index`, `_seq_no`, `_primary_term` and the JSON tree. Table/JSON toggle shows
    cards instead.
12. Edit (pencil or double-click): Monaco JSON with parse-error underline; Ctrl+Enter saves with `if_seq_no` +
    `if_primary_term`. Meanwhile change the same document elsewhere (Dev Tools `POST /shop-products/_update/<id>`):
    Save → warning "Someone changed this document …" with **Reload latest** (loads the new version) and **Overwrite**.
13. Clone (new document with the same body, `_id` empty = generated), + Document, Delete (confirm, uses `if_seq_no`).
14. Read-only connection: edit/clone/new/delete are disabled with the reason as tooltip.

## Index details
15. Mappings: fields table (path with multi-fields under their parent, type colour, searchable/aggregatable) or JSON;
    **Add fields…** PUTs new properties (changing a type answers `illegal_argument_exception: mapper [x] cannot be changed`).
16. Settings: shards/replicas/refresh summary + JSON; **Edit settings…** (e.g. `number_of_replicas`); static settings are
    rejected with the server's message.
17. Aliases (add/remove), Shards (map + table; unassigned replicas on a single node explained), Stats (tiles + raw).

## Search
18. Search tab: index/alias/pattern box with completion of known names; DSL editor. Completion (Ctrl+Space or typing
    `"`): root keys (`query`, `aggs`, `sort`, `_source`, `highlight` …), query clauses inside `query`/`must`/`filter`,
    `bool` parameters, field names of the target inside `match`/`term`/`range`, field-name values for `"field"`, nested
    paths for `"path"`, enum values (`operator`, `calendar_interval`, `order`), agg types inside an aggregation.
19. Examples… fills bodies from the mapping (match + highlight, bool filters, terms, date histogram with a sub-average,
    stats/ranges, nested). Run (Ctrl+Enter).
20. Hits: score, id, index, preview; expand for highlights (`<em>` → marks), sort values and the JSON; **Explain** adds
    the score explanation tree.
21. Aggregations: bucket tables with doc-count bars and sub-metric columns, nested bucket aggs expandable, metric tiles,
    top_hits lists. Response: the raw JSON tree. Copy as console / Open in Dev Tools.
22. Invalid DSL → banner `parsing_exception: unknown query [bogus]` (root cause appended when different).

## Dev Tools
23. Default text has three requests. ▶ in the gutter runs that request; Ctrl+Enter runs the request at the cursor (the
    active request is highlighted); a selection runs the selected requests; Ctrl+Shift+Enter runs all (responses
    concatenated with `# METHOD path  status · time` headers).
24. Completion: methods at a line start, API paths after the method (flavor-aware: `_sql` vs `_plugins/_sql`), index names
    with `_search`/`_count`/`_mapping`, DSL keys and fields inside search bodies, `settings`/`mappings`/`aliases` in
    `PUT /index` bodies.
25. Response pane: status pill (green 2xx, amber 4xx, red 5xx), time, foldable read-only JSON; text responses
    (`_cat/*?v`) as text. Errors from Elasticsearch show as the response (status 400/404), not as an app error.
26. `POST /_bulk` with NDJSON lines (trailing commas/comments tolerated); `GET /_cat/indices?v&s=index`.
27. Auto-indent, Copy as cURL (first URL of the connection), History (last 50 per connection, click inserts).
28. Read-only connection: GET/HEAD and read-only POSTs (`_search`, `_count`, `_msearch`, `_mget`, `_sql`, …) work;
    `PUT`, `DELETE`, `POST /_bulk` answer "read-only".

## SQL
29. SQL tab: default GROUP BY query (identifiers quoted for the flavor), Ctrl+Enter runs, typed column headers, "More rows"
    while the cursor has pages, Translate to DSL shows the query DSL. Completion: index names after FROM, fields of the
    FROM target, keywords.

## Jobs, tasks, index management
30. Create index… (name rules checked as you type, shards, replicas, optional settings/mappings/aliases JSON) → opens
    its Mappings.
31. Delete index… requires typing the name; tabs of the index close.
32. Reindex… (source, destination, optional query, conflicts, max docs) runs as a job: progress bar, Cancel job, result
    `N created · M updated · conflicts · time`; the Tasks tab shows the reindex task while it runs.
33. Export… NDJSON / JSON / CSV, optional fields, query, max, include `_index`/`_id`: desktop asks for a path and runs a
    job; the browser build downloads the file.
34. Import… NDJSON (also `_bulk` files) / JSON array / CSV with a header; preview of the first documents; id field; batch
    size; job with progress and the first 20 item errors.
35. Tasks: live every 2 s while visible (Pause/Live), filter, child/monitoring toggle, progress of by-query/reindex tasks,
    Cancel (disabled on read-only connections).
36. Close index… / Open index; Refresh / Flush / Force merge… report success as toasts.

## OpenSearch (manual check, opensearchproject/opensearch:2, security disabled)
37. Test shows `OpenSearch 2.x`; overview badge "OpenSearch"; nodes, indices, mappings, documents, search, aggregations,
    console, reindex/import/export and tasks work as above (engine live suite `OpenSearchLiveTests`, 6/6 green).
38. SQL goes to `_plugins/_sql` (JDBC format, cursor paging); index names are quoted with backticks
    (`` SELECT * FROM `shop-orders` ``); Translate uses `_plugins/_sql/_explain`.

Screenshots of the mock build (light and dark): overview, documents (Persian names), mappings, search with a date
histogram, Dev Tools, SQL, tasks — taken with `ui/scripts/shot.mjs` against `npm run dev:mock`.
