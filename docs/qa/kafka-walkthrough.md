# Kafka walkthrough (M2-K, docs/PLAN-M2.md section 7)

Pass/fail per step. Run in both themes and at 150 % app zoom. Keyboard-only steps are marked ⌨. Screenshots of the
mock build are in `docs/qa/kafka/`.

## Setup
- Real cluster: `docker compose -f engine/tests/docker/compose.yml --profile kafka up -d`, then
  `bash engine/tests/docker/seed-kafka.sh` (topics `orders` 3p / 120 JSON messages with keys and headers,
  `payments-avro`, `events-proto`, `compacted-users`; subjects `payments-avro-value` (Avro), `events-proto-value`
  (Protobuf); groups `billing` (lag) and `shipping`). Connection: bootstrap `localhost:19092`, PLAINTEXT, Schema
  Registry `http://localhost:18081`.
- SASL_SSL: any cloud cluster (Confluent Cloud / Aiven / MSK with SCRAM) with a CA file; the password and the Schema
  Registry secret are stored in the OS secret store (D12), never in `connections.json`.
- No Docker: `npm run dev:mock` → connection **Kafka Dev** (`c_kafka`): 3 brokers, topics `orders` (300 JSON messages),
  `payments` (Avro-decoded, one under-replicated partition), `events`, `compacted-users`, internal `__consumer_offsets`
  / `_schemas`; groups `billing` (Empty, lag), `shipping` (Stable, 2 members), `analytics`. Add a Schema Registry URL
  to the connection (any URL) to enable the registry formats and the Schema Registry folder.

## Connect
1. New connection → Apache Kafka. Bootstrap `host:port[,host:port]` is required and validated (`localhost` without a
   port → "must be host:port"). Security protocol PLAINTEXT / SSL / SASL_PLAINTEXT / SASL_SSL; SASL user required for
   SASL_* (except OAUTHBEARER). **Test** → `Kafka 3.8 (3 brokers, controller 1); Schema Registry ok`. A wrong registry
   URL still tests OK with `; warning: Schema Registry is unreachable: …`.
2. Unreachable bootstrap (`127.0.0.1:1`) → fails within the request timeout with "Cannot reach the Kafka brokers: … (1/1
   brokers are down)"; the dialog stays usable.
3. `extra` = `linger.ms=5;socket.keepalive.enable=true` is passed to librdkafka; `sasl.password=…` in `extra` is refused
   (field `extra`).
4. Connect (Welcome card / double-click) opens **Cluster overview** (`01-overview.jpg`).

## Explorer and overview
5. Connection → Overview, Topics (count), Consumer groups (count), Schema Registry (only when configured: subjects with
   type and latest version; Enter opens the schema). Topic rows show `3p · 300`, `under-replicated` when ISR < replicas.
6. Internal topics are hidden; Ctrl+Shift+P → "Show internal topics" or the **Internal topics** chip of Topics shows them.
7. Context menus (`02-explorer-topic-menu.jpg`): topic → Browse messages, Produce…, Topic configs, Consumer groups of this
   topic, Add partitions…, Delete topic… (danger); group → Open, Reset offsets…, Delete consumer group… (danger); Topics /
   Consumer groups / Overview → Cluster overview, Create topic….
8. Overview tiles: brokers, controller, topics, partitions, under-replicated (warning colour when > 0), offline (danger
   when > 0), consumer groups, log retention (controller's `log.retention.*`), version. Broker grid marks the controller;
   **Broker configs** opens the drawer (filter, non-default only, sensitive values masked).
9. Ctrl+P `t:ord` finds the topic `orders` (all connections' loaded topics) and opens it.

## Topics
10. Topics grid: search, chips Internal / Under-replicated, sort by name / partitions / messages (estimated: sum of
    high − low watermarks). ⌨ Tab to a row, Enter opens the topic tab.
11. **New topic…**: name validation (letters, digits, `.`, `_`, `-`), partitions, replication factor (> brokers → "larger
    than available brokers"), configs as `name=value` lines. Creates and refreshes the tree.
12. Topic tab → Overview: partition grid (leader, replicas, ISR, low/high, messages, health pill).
13. Configs (`05-topic-configs.jpg`): non-default rows marked (accent bar), sensitive masked; Edit / Reset (= delete the
    override) are staged ("2 pending"), **Save changes** sends one IncrementalAlterConfigs; Discard reverts; invalid
    names come back as a validation banner.
14. **Add partitions…**: new total must exceed the current count.
15. **Purge…** and **Delete…** require typing the topic name; purge empties every partition (DeleteRecords to the high
    watermark) and the overview shows low = high; delete closes the topic's tabs.

## Message browser and live tail
16. Browse messages (`03-message-browser.jpg`): Latest N (per partition, newest first across partitions, limit overall),
    Oldest, Offset (clamped to each partition), Timestamp (OffsetsForTimes); partition select All / one.
17. Key/value decoders: String (invalid UTF-8 → hex + "Not valid UTF-8" note), JSON (parse error shown, text kept), Hex,
    Int32/Int64 (big-endian; wrong length → note), Avro / Protobuf / JSON Schema (registry; schema id + subject in the
    detail), Auto (magic byte → registry, `{`/`[` → JSON, else string). Registry formats are disabled without a registry.
18. Search in value (Aa = match case) filters server-side; the status line shows "N messages matching … · M scanned",
    and "more available" when the limit / 10 MB cap stopped it, "stopped at the timeout" after 8 s.
19. ⌨ The list is a listbox: ↑/↓/Home/End move the selection; the detail shows pretty JSON (toggle), Copy, headers, key,
    partition/offset, timestamp type. Values > 32 KB show **Load full** (GET …/messages/{p}/{o}).
20. **Produce similar** opens Produce with key, value (pretty JSON), headers and formats prefilled.
21. **Live tail** (`04-live-tail.jpg`): starts at the end, appends at the bottom and follows; scrolling up stops following
    and shows **Jump to live**; **Pause** pauses the consumer (no drops), **Resume** delivers the backlog; beyond 10,000
    rows the oldest are dropped and "dropped N" is shown. Toggle Live tail off closes the stream. Disconnecting the
    source client ends the tail ("Live tail ended: source-closed").

## Produce
22. Produce (`08-produce.jpg`): partition Auto/explicit, key (empty = null key), formats string / json / hex / avro /
    protobuf / jsonschema (subject + version, key subject), value in Monaco (JSON highlighting + parse markers;
    Ctrl+Enter produces), headers table, compression, Repeat N (≤ 1000) with `${i}`. The result table lists partition /
    offset / timestamp per message. Avro with a value that does not match the schema → "does not match schema N: $.field: …".

## Consumer groups and offsets
23. Consumer groups grid: state pill, members, topics, lag (heat colours; thresholds editable, remembered per window);
    lag "—" when the 10 s lag budget ran out.
24. Group tab (`06-group.jpg`): tiles, members (client id, host, assignment), partitions (committed, low, high, lag,
    member); Refresh and Auto-refresh 5 s.
25. **Reset offsets…** (`07-reset-offsets-dry-run.jpg`): topic (or all committed partitions), Earliest / Latest / Specific
    offset / Timestamp / Shift by. **Preview (dry run)** lists from → to → Δ; **Apply** needs the preview and the typed
    group id. On `billing` (Empty) it applies; on `shipping` (Stable) it is refused with 409 GROUP_ACTIVE and the members
    are listed in the dialog.
26. **Delete consumer group…** with typed id; refused for active groups.

## Read-only
27. Mark the connection read-only: Produce, Create topic, Add partitions, Purge, Delete topic, Delete group are disabled
    in menus and views; the engine answers 403 READ_ONLY naming the action for each (e.g. "…is read-only: producing to
    topic 'orders' is not allowed."). Browsing, tailing, configs (view) and offset-reset **dry runs** still work.

## Native packaging (librdkafka, D8) — blocking
28. win-x64: `scripts/build.ps1 -EngineOnly` (single file, `IncludeNativeLibrariesForSelfExtract=true`), then
    `node scripts/ci/kafka-native-smoke.mjs engine/publish/DbStudio.Engine.exe` → "Engine native smoke ok: … librdkafka
    2.6.1; kafka test -> Cannot reach the Kafka brokers …". The smoke checks GET /providers (7 providers),
    GET /kafka/library (forces `Library.VersionString`) and POST /connections/test (kafka @ 127.0.0.1:1 must fail with a
    librdkafka error, `error.detail = "librdkafka 2.6.1"`; a load failure would answer ENGINE_ERROR "librdkafka-missing").
29. macOS (CI macOS job, same script on `engine/publish/osx-arm64/DbStudio.Engine`): additionally `librdkafka.dylib` next to
    the apphost for osx-arm64 and osx-x64 (`file` shows the architecture, `otool -L` only /usr/lib and /System
    dependencies), the osx-x64 engine runs the REST checks under Rosetta when available, and `codesign --verify --strict`
    passes for every librdkafka.dylib inside `desktop/dist/**/DbStudio.app`.
30. Installer smoke: Kafka connection test from the installed app on Windows, Apple Silicon and Intel Macs.

### Packaging notes (measured 2026-10-18, win-x64, Release, single file, compressed)
- Engine size: 59.6 MB (M2-0 tree) → 65.0 MB with Confluent.Kafka 2.6.1 + Schema Registry serdes (+5.3 MB; budget
  +45 MB). The bundled natives are librdkafka.dll 2.3 MB, libcrypto-3-x64 4.7 MB, libssl-3-x64 0.8 MB, libcurl 0.6 MB,
  zstd 0.65 MB, zlib1, librdkafkacpp, msvcp140, vcruntime140 (13 MB uncompressed in the extraction folder, together
  with SNI and e_sqlite3).
- First start (extraction to `%TEMP%\.net\DbStudio.Engine\<hash>`): ready in 0.71 s; warm start 0.52 s (< 1.5 s budget,
  so the folder-layout fallback of D8 is not needed).
- macOS (D8): `scripts/build.sh` publishes with `IncludeNativeLibrariesForSelfExtract=false`, so the SDK places
  `runtimes/osx-<arch>/native/librdkafka.dylib` (osx-arm64 6.7 MB, osx-x64 7.7 MB in librdkafka.redist 2.6.1; the smoke asserts that it links
  only system libraries) next to the apphost exactly like `libe_sqlite3.dylib`; electron-builder
  copies `engine/publish/osx-<arch>/**` into the app and signs every Mach-O with the app (hardened runtime, library
  validation satisfied because the dylib carries the app's signature). Nothing is extracted or loaded from a temp folder.
  `KafkaNative.EnsureLoaded()` loads `AppContext.BaseDirectory/librdkafka.dylib` explicitly (Confluent's own probing
  relies on the assembly location, which is empty in single-file apps).
- The Docker suite (`KafkaIntegrationTests`, `apache/kafka:3.8.0` KRaft via Testcontainers or `DBSTUDIO_KAFKA_BOOTSTRAP`)
  covers produce → browse (latest / timestamp) → group reset → lag → configs on a real broker.

## Engine API reference (for curl checks)
`GET /api/v1/kafka/library`; under `/api/v1/kafka/{cid}`: `GET cluster`, `GET brokers/{id}/configs`,
`GET topics?includeInternal=`, `POST topics`, `GET|DELETE topics/{t}`, `PUT topics/{t}/configs`,
`POST topics/{t}/partitions`, `POST topics/{t}/purge`, `POST topics/{t}/messages` (202 `{jobId, streamId}`, messages on
the `kafka.fetch` stream), `GET topics/{t}/messages/{p}/{o}`, `POST topics/{t}/produce`, `GET groups`, `GET|DELETE
groups/{g}`, `POST groups/{g}/offsets`, `GET schemas/subjects`, `GET schemas/subjects/{s}/versions/{v}`. Streams:
`POST /api/v1/streams { kind: "kafka.tail", connectionId, params: { topic, partitions, from, offsets, keyFormat,
valueFormat, filter } }`.
