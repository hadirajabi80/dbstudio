# MongoDB walkthrough (package M2-M, docs/PLAN-M2.md §6, §11 "MongoDB")

Pass/fail checklist for the MongoDB source. Run each section against **both** back ends:

- **Mock**: `npm --prefix ui run dev:mock`, then use the `Mongo Shop` connection. It is the `shop` fixture from `ui/src/mocks/m2/mongo.ts`: 60 customers, 240 orders, 12 products, the `paid_orders` view and the `analytics.events` time series.
- **Real**: run `docker compose -f engine/tests/docker/compose.yml up -d mongo`. This starts a single-node replica set `rs0` seeded by `engine/tests/docker/seed-mongo.js`. Connect with URI `mongodb://localhost:27018/?directConnection=true`. Change streams need this replica set.

Screenshots in both themes are in `docs/qa/mongo/`: `documents`, `table`, `aggregation`, `export-code`, `explain`, `schema`, `indexes` and `validation`, each as `-light.png` and `-dark.png`, plus `explain-collscan-light.jpg`.

## 1. Connection (§6.1)
| # | Step | Expected |
|---|---|---|
| 1.1 | New connection → MongoDB. Enter URI `mongodb://localhost:27018/?directConnection=true` and click **Test**. | `MongoDB 7.0.x (replica set rs0)` |
| 1.2 | Use URI `mongodb://127.0.0.1:1`, set connect timeout to 2, then Test. | Fails within about 3 s with `SOURCE_UNAVAILABLE` and the driver message |
| 1.3 | Use a `mongodb+srv://nonexistent.example.net` URI. | `SOURCE_UNAVAILABLE` with the DNS resolver message; it does not hang longer than the connect timeout |
| 1.4 | Enter a URI without credentials, plus a user and password in the form. | Connects (credentials are merged); the password is not stored in `connections.json` |
| 1.5 | Set TLS + CA file, or TLS + "allow invalid certificates", against a TLS server (manual, e.g. Atlas). | Connects; with a wrong CA it fails with a certificate error |
| 1.6 | Set *Database* = `shop`. | The explorer shows only `shop` |

## 2. Explorer (§6.2)
| # | Step | Expected |
|---|---|---|
| 2.1 | Expand the connection. | Databases appear with their size and collection count |
| 2.2 | Expand `shop`. | Collections are sorted. Each has a type icon (collection, view (eye), time series (clock)) and an estimated count (`orders 240`, `paid_orders view`) |
| 2.3 | Press Enter or double-click on `orders`. | The `shop.orders` tab opens on Documents. Opening it again activates the same tab |
| 2.4 | Context menu on a collection. | Open documents, Aggregation pipeline, Analyze schema, Indexes, Explain plan…, Validation rules, Import…, Export…, Rename…, Drop…. On a view, Indexes, Validation and Rename are disabled |
| 2.5 | Context menu on the database → **New collection…**. Try Collection, Capped, Time series and View. | Each is created and the tree refreshes |
| 2.6 | **Drop collection…** / **Drop database…** | The danger button stays disabled until the exact name is typed; open tabs of what was dropped close |
| 2.7 | Ctrl+P, type `coll:ord`. | `shop.orders` is listed; Enter opens it |
| 2.8 | Explorer filter `prod`. | Only `shop › products` remains |

## 3. Documents (§6.3)
| # | Step | Expected |
|---|---|---|
| 3.1 | Open `orders`. | Header reads `shop.orders · 240 documents · size · 3 indexes`; the first 20 cards show; count `1–20 of 240` |
| 3.2 | In Filter, type `{ st`. | Completion offers `status` (type String). Type `: `: the sampled values `"paid"`, `"pending"`, … appear, followed by helpers (ISODate, ObjectId…) |
| 3.3 | Type `{ total: { $` | Query operators appear with docs (`$gt`, `$in`, `$exists` …); hovering an operator shows its summary |
| 3.4 | Enter `{ status: "paid", total: { $gt: 100 } }` and press Enter. | Shows `1–20 of 90 (filtered)` (mock) |
| 3.5 | Options → Project `{ total: 1, _id: 0 }`, Sort `{ total: -1 }`, Limit 5 → Find. | 5 cards, sorted, no `_id` |
| 3.6 | Type `{ status: paid }` | Red underline, the message `filter: Unknown identifier 'paid'…`, and Find is disabled |
| 3.7 | Use `$where` in the mock, or a slow count against a real server. | The count turns into `~240` with an amber **estimated** pill |
| 3.8 | Click next/previous page. | The skip moves by the limit and the range text updates |
| 3.9 | Switch List / JSON / Table. | All three show the same page. JSON is a read-only editor. Table columns are the union of fields with `_id` first; `[3]` drills into `items` and a breadcrumb leads back |
| 3.10 | In JSON view: **Edit**, change one value, **Save changes (1)**. | Asks for confirmation, then replaces exactly one document |
| 3.11 | The order with `notes` (`{ notes: { $exists: true } }`) | The string is cut, with an amber `38,500 chars` badge. **Edit** loads the full document |
| 3.12 | Keyboard: ↓/↑ moves the selection; Enter edits; Delete shows the inline confirmation. | as described |
| 3.13 | Recent queries (clock icon). | The last 10 queries of the collection; clicking one runs it again |

## 4. EJSON round trip (§6.3, QA "EJSON types round-trip edits")
| # | Step | Expected |
|---|---|---|
| 4.1 | **Insert** `{ _id: ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa"), at: ISODate("2024-05-01T10:00:00Z"), big: NumberLong("9007199254740993"), price: NumberDecimal("19.99"), bin: BinData(0, "AQID"), ratio: 2.0, n: 3 }` | Inserted |
| 4.2 | Edit that document, change nothing, and Replace. | Types stay as they were: ObjectId, Date, Int64 (exact beyond 2^53), Decimal128, Binary, Double `2.0`, Int32 `3` |
| 4.3 | Change `_id` while editing. | Confirmation "Change _id?"; the edited document is inserted and the old one deleted |
| 4.4 | **Clone** | The editor opens without `_id`; Insert creates a new document |
| 4.5 | **Delete** → Delete. | The document is gone and the header count drops |
| 4.6 | Insert `[ { a: 1 }, { a: 2 } ]` | 2 documents inserted |

## 5. Aggregations (§6.4)
| # | Step | Expected |
|---|---|---|
| 5.1 | Aggregations → **Import text** with `[{ $match: { status: "paid" } }, { $unwind: "$items" }, { $group: { _id: "$items.sku", qty: { $sum: "$items.qty" } } }, { $sort: { qty: -1 } }]` | Four stage cards. Each shows "Output after $… : first 10 documents" about 0.5 s after an edit; editing a stage re-runs only that stage and later ones |
| 5.2 | Break stage 1 (`{ status: }`). | Stage 1 shows the parse error; later previews read "Fix stage 1 first." |
| 5.3 | Use the stage picker, the enable switch, ↑ / ↓, + and the trash icon. Then the keyboard: Ctrl+Shift+A adds a stage, Alt+↑/↓ moves the focused stage, Ctrl+/ toggles it. | Each works as described |
| 5.4 | Completion inside `$group`. | `_id`, then accumulators (`$sum`…); `"$` offers field references |
| 5.5 | **Run** | Output pages 20 at a time |
| 5.6 | Add `$out: "paid_copy"`. | The preview notes that the write stage is skipped. Run asks "Run a write stage?". On a read-only connection the toast says it is read-only |
| 5.7 | **Export to code**: mongosh, Node.js, C#, Python, Java; toggle "Include imports and client"; Copy. | The code parses or compiles (snapshot tests in `exportCode.test.ts`) |
| 5.8 | **Save** a pipeline, reload the app, **Open** it. | The stages come back (`settings.ui.mongoPipelines`) |
| 5.9 | **Explain** in the toolbar. | The Explain tab opens for the pipeline |

## 6. Schema, indexes, validation, explain (§6.5)
| # | Step | Expected |
|---|---|---|
| 6.1 | `customers` → Schema → **Analyze schema** | A progress bar, then the field table: stacked type bars, presence %, example chips, min/max/distinct. `phone` is highlighted with **mixed types** (String / Int32), present in 81.7 % |
| 6.2 | Click an example chip of `tier`. | Documents opens with `{ tier: "…" }` |
| 6.3 | **Export JSON Schema** / **Use as validation** | The first downloads `customers.schema.json`; the second opens Validation with a `$jsonSchema` draft |
| 6.4 | Indexes: list | Name, key chips, type (Regular/Compound/Text/TTL…), size, usage (`$indexStats` ops), and pills (unique, sparse, partial, TTL, collation) |
| 6.5 | **Create index** with field `total` and type 1. | On a large collection a progress bar reads "Building total_1…", then the row appears |
| 6.6 | Two fields + TTL | Refused: "TTL indexes have exactly one field." |
| 6.7 | Drop the index (danger confirmation showing `db.orders.dropIndex("…")`). | The row is removed. `_id_` has no drop button |
| 6.8 | Validation on `customers` | Shows the existing `$jsonSchema`, level Moderate and action Warn |
| 6.9 | Change it to `{ tier: "gold" }` → **Test against sample** | "N documents would fail" plus the first 20 failing documents |
| 6.10 | **Save**, then **Revert** | collMod is applied; Revert restores the server state |
| 6.11 | **Generate from schema** | A `$jsonSchema` draft from 1,000 sampled documents |
| 6.12 | Query `{ total: { $gt: 100 } }` sort `{ total: -1 }` → **Explain** | Summary cards show No index (COLLSCAN) and docs examined, and the amber banner reads "Collection scan: no index was used to find the documents." The tree shows LIMIT → SORT (In-memory sort) → COLLSCAN (Collection scan) |
| 6.13 | Query `{ status: "paid" }` → Explain | IXSCAN on `status_1_createdAt_-1` → FETCH; the index used is shown in green |
| 6.14 | Switch verbosity to Query planner; switch to Raw output. | Counts become "—" with an explanatory note; Raw shows the server's explain |

## 7. Import / export / change streams
| # | Step | Expected |
|---|---|---|
| 7.1 | Import a CSV `sku,qty,price,active,since` | Mapping table: qty → Number (or String if a value is not numeric), price → Number, active → Boolean, since → Date. Changing a type re-runs the preview |
| 7.2 | Import with a cell that does not fit its type | Row error "row 2: 'x' is not a number for column qty" in the preview and in the result list (first 100) |
| 7.3 | Import JSON Lines in Upsert mode by `_id` | Result: n inserted, m upserted |
| 7.4 | Desktop: Export → JSON (Relaxed / Canonical), JSON Lines, CSV (choose columns) | A job writes the file and the toast shows its path. Browser: the file downloads (`orders.csv`) |
| 7.5 | Re-import a Canonical JSON export | Every type is preserved |
| 7.6 | Click **Watch** on `orders` (the mock simulates updates; on a real server, insert from mongosh) | The button reads "Watching" (pulsing). The badge "+3 changes, click to refresh" appears; the chevron lists recent operations. Clicking refreshes and resets the count |
| 7.7 | Watch on a standalone server | "Watch failed" with the server message (change streams need a replica set) |

## 8. Read-only and errors
| # | Step | Expected |
|---|---|---|
| 8.1 | Mark the connection read-only | A lock pill in the header. Insert, Import, Edit, Delete, Create index, Save validation, the rename/drop menus and `$out` runs are all disabled or refused. The engine answers `403 READ_ONLY`, naming the action |
| 8.2 | A user without `listDatabases` / `$indexStats` | The databases list falls back to authorized databases; index usage shows "—" (not permitted); `PRIVILEGE` errors name the needed action |
| 8.3 | Stop the server while the documents view is open | The next request is `SOURCE_UNAVAILABLE` and the client is marked broken; reconnecting works |

## Keyboard-only walk
Ctrl+P → `coll:orders` → Enter. The focus is in Filter: type a query and press Enter. Tab moves through Options, Explain, Reset, Find and the toolbar. Then use ↓ / Enter (edit) / Ctrl+Enter (save) / Esc. In the sub-tab strip, ←/→ moves between tabs. In Aggregations: Ctrl+Shift+A, then Alt+↑/↓ and Ctrl+/ on the focused stage header.

## Known deviations from the plan
- Compass-style workspace: one tab per collection with sub-tabs. The plan's view ids `mongo.aggregate|schema|indexes|explain|validation|import` are registered as aliases of it.
- Collections are explorer leaves, so Enter and double-click open them; the explorer toggles containers. Indexes and Validation are sub-tabs and context-menu entries rather than child nodes.
- Explain uses its own visual tree (stage boxes with Compass-like summary cards) instead of the SQL `PlanView`. PlanView labels plans by SQL dialect and is owned by another package.
- The editors use mongosh shell syntax (`ObjectId("…")`) rather than raw EJSON; the engine parses both, and Copy produces relaxed EJSON.
