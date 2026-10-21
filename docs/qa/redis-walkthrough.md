# Redis walkthrough (package M2-R, docs/PLAN-M2.md §5, §11 "Redis")

This is the pass/fail checklist for the Redis source. Run each section against **both** back ends:

- **Mock**: run `npm --prefix ui run dev:mock` and use the `Redis Cache` connection. Its fixture is in `ui/src/mocks/m2/redis.ts`. db0 has 5,000 keys of every type:
  - `user:<n>:profile` hashes and `user:<n>:cart` lists
  - `session:*` strings with TTLs, and `cache:page:*` strings
  - `leaderboard:daily` and `leaderboard:weekly` sorted sets, and the `queue:emails` list (640 items)
  - `tags:*` sets
  - `events:orders`, a stream with the consumer groups `billing` (10 pending) and `analytics`
  - `doc:product:*` RedisJSON documents
  - `bin:thumbnail` (binary) and `config:feature-flags` (JSON)

  db1 holds two keys.
- **Real**: run `docker compose -f engine/tests/docker/compose.yml up -d redis`. This starts `redis/redis-stack:7.4.0-v1` on port 16379, seeded by `engine/tests/docker/seed-redis.sh`, which writes about 10k keys and includes RedisJSON. For cluster mode, add `--profile cluster`. Connect as Standalone with host `localhost` and port `16379`.

Screenshots of both themes are in `docs/qa/redis/`:
- `browser-light.png` and `browser-dark.png`: the key browser on `user:1001:profile`
- `workbench-light.png` and `workbench-dark.png`: the Workbench after **Run all**

Shortcuts listed as "(local)" are handled by the view itself, because the global binding belongs to consoles (see §8).

## 1. Connection (§5.1)
| # | Step | Expected |
|---|---|---|
| 1.1 | Open New connection → Redis. Use Standalone, `localhost:16379`, and click **Test**. | `Redis 7.4.x`. The server name is the endpoint and the user is `default` |
| 1.2 | Use Port `1` and Test. | Fails within the connect timeout with `SOURCE_UNAVAILABLE`. The message has no StackExchange.Redis advice text |
| 1.3 | Use a wrong password, or an ACL user with a wrong password. | Test fails with the WRONGPASS message |
| 1.4 | Set *User* to an ACL user with `+@read ~*` (`ACL SETUSER ro on >pw ~* +@read +info +scan +type +ttl`). | Connects. The browser reads keys. Server-denied actions show a `PRIVILEGE` error that names the missing permission (`+set`) |
| 1.5 | Set *Database* to `3`. | The browser opens on db3. A database beyond the server's count fails with `VALIDATION`, field `db` |
| 1.6 | Use *Mode* Cluster with nodes `localhost:17001,localhost:17002,localhost:17003` (`--profile cluster`; the nodes announce container addresses, so run it on Linux or inside the compose network). | Connects. The explorer shows one `keys` root, and the browser has no DB selector. SCAN cursors look like `host:port@cursor;…` |
| 1.7 | Use *Mode* Sentinel with sentinels and service `mymaster` (manual). | Connects to the current master |
| 1.8 | Turn on TLS + *Skip certificate verification* against a TLS endpoint (manual, e.g. a managed Redis). | Connects. Without skip-verify and with a self-signed certificate, it fails with a certificate error |
| 1.9 | Edit the connection's props. | The cached explorer tree and server facts are dropped and reloaded |

## 2. Explorer (§5.2)
| # | Step | Expected |
|---|---|---|
| 2.1 | Expand the connection. | `db0 5,000` and `db1`, then Workbench, CLI, Pub/Sub, Slowlog, Info and Analysis |
| 2.2 | Expand `db0`. | Shows delimiter folders such as `user` and `session` with key counts. Because the database has more than 1,000 keys, the hint "1,000 of 5,000 keys: open the browser to scan more" appears |
| 2.3 | Expand `session`. | Keys show a type icon and a TTL badge (`1h 52m`). Expanding a folder of a truncated database scans `SCAN MATCH session:*` |
| 2.4 | Press Enter on a key. | The browser tab of that database opens with the key selected. Opening it again activates the same tab |
| 2.5 | Context menu on a key. | Open key, Rename…, Set TTL…, Copy key name, Copy value as JSON, Delete… (in red). On a read-only connection, the writes are disabled |
| 2.6 | Context menu on a folder. | Open in browser with this pattern (escapes `[ ] * ? \`), Delete keys matching… |
| 2.7 | Context menu on `db1` → **Flush database…**. | The button stays disabled until `db1` is typed. Then FLUSHDB runs and the tree refreshes |
| 2.8 | Press Ctrl+P and type `k:greet`. | `greeting` (`Redis Cache · db0`) appears. Enter opens it |
| 2.9 | Type `user:10` in the explorer filter. | Only db0 and the matching cached keys remain, with the match highlighted |

## 3. Key browser (§5.3)
| # | Step | Expected |
|---|---|---|
| 3.1 | Open the browser. | The first page (about 500 keys) appears as a tree. The status reads `500 keys · scanned 500 of ~5,000`. **Scan more** continues the cursor |
| 3.2 | Click Scan more until it disappears. | All 5,000 keys load. Scrolling stays smooth because only the visible rows render |
| 3.3 | Use a real server with 100k keys (`DEBUG POPULATE 100000`), then Scan more repeatedly. | The view stays responsive. It stops at 100,000 keys with "refine the pattern" |
| 3.4 | Type `leaderboard` in the pattern box (Ctrl+F) and press Enter. | The scan uses `*leaderboard*`. A glob such as `user:10?:*` is used as typed. Esc clears it |
| 3.5 | Set Type to Stream. | `SCAN TYPE stream`, or TYPE per key on Redis < 6. Only streams remain |
| 3.6 | Switch Tree to List. | Full key names appear in natural sort order |
| 3.7 | Watch the TTL column of a `session:*` key. | It counts down every second, and turns amber under 60 s |
| 3.8 | Look at the Size column. | `MEMORY USAGE` badges load lazily for the visible rows, in batches of up to 100 |
| 3.9 | Use the keyboard in the list: ↑ ↓ Home End PgUp PgDn, → ← on folders, Enter. | Moves, opens and closes folders, and selects keys. Alt+← / Alt+→ jump between the list and the value pane |
| 3.10 | Press F5 (local). | Rescans from the beginning |
| 3.11 | Switch DB in the toolbar. | Rescans that database. Each db shows its key count |

## 4. Value editors (§5.3)
| # | Step | Expected |
|---|---|---|
| 4.1 | Open `config:feature-flags`. | The JSON badge shows. **Pretty** reformats and **Compact** folds it back. Edit, then press Ctrl+S: `SET … KEEPTTL` runs and the TTL is kept |
| 4.2 | Open `bin:thumbnail`. | A hex dump appears, marked "Binary · hex · read-only" |
| 4.3 | Open a string over 1 MB. | "Showing the first 1 MB of N MB · read-only" |
| 4.4 | Open `user:1001:profile` (hash). | Shows Field / Value. Click a value to edit (Enter commits, Shift+Enter breaks the line, Esc cancels). Add a field, delete a field: "3 pending changes". Save sends one request (HSET + HDEL). Discard reverts. The filter uses HSCAN MATCH, and "Load more fields" pages |
| 4.5 | Open `queue:emails` (list). | `Items 0–199 of 640`. Next/Previous page. LPUSH/RPUSH adds a value. Editing an element runs LSET. The trash icon runs LREM 1 |
| 4.6 | Open `tags:post:1` (set). | Add and remove members (pending, then Save). The filter uses SSCAN MATCH |
| 4.7 | Open `leaderboard:daily` (zset). | Sorted by score. ↑/↓ toggles the order. Editing a score and adding a member+score saves with ZADD. `+inf` displays as `+inf` |
| 4.8 | Open `events:orders` (stream). | Entries newest first, with one column per field. "Load older entries" pages (`stop=(id`). XADD adds an entry and the trash icon runs XDEL |
| 4.9 | Open the stream's **Consumer groups** tab. | `billing` (2 consumers, 10 pending, lag) and `analytics`. Expanding a group shows its consumers (pending, idle) and its pending entries (deliveries). **ACK** and **ACK all shown** acknowledge. Create group (`$` or `0`) and Destroy group (with a confirmation) work |
| 4.10 | Open `doc:product:1` (RedisJSON). | A pretty JSON editor. Invalid JSON shows "Invalid JSON" and disables Save. Save runs `JSON.SET key $ …` |
| 4.11 | The key is deleted elsewhere while it is open. | Refresh shows "The key does not exist any more" and the key leaves the list |

## 5. Key actions (§5.3)
| # | Step | Expected |
|---|---|---|
| 5.1 | Click **+ Key**, or press Insert in the key list. Create each type (string, hash, list, set, zset, stream, JSON) with TTL `15m`. | The key is created (`EXISTS` is checked first), selected and revealed in the tree. A duplicate name shows "already exists" |
| 5.2 | Press F2 on a key and rename it. | Uses RENAMENX. If the target exists, an error offers *Overwrite* (RENAME). The list follows the new name. In cluster mode, different hash slots give an explanation with a hash-tag hint |
| 5.3 | Click **TTL**, choose a preset or type `90`, `2h` or `1d`. **Remove TTL** runs PERSIST. | The badge updates without a rescan |
| 5.4 | Press Delete on a key. | A danger confirmation opens with Cancel focused. Confirming runs UNLINK and the row disappears |
| 5.5 | Use folder → **Delete keys matching…** (or the palette with a pattern in the browser). | Counts the matches, then requires typing that number. The job shows progress, and **Cancel job** stops it (keys already deleted stay deleted). The tree refreshes afterwards |
| 5.6 | Use Copy name and Copy JSON. | The key name, and the value as JSON (hash → object, zset → `[{member, score}]`), are copied to the clipboard |

## 6. Workbench and CLI (§5.4)
| # | Step | Expected |
|---|---|---|
| 6.1 | Type `hg` in the Workbench. | Completion offers `HGET`, `HGETALL`… with the syntax and docs. After `HGETALL `, the cached key names are offered (quoted when needed). After `SET k v `, it offers NX, XX, EX, KEEPTTL… |
| 6.2 | Hover `ZADD`. | Shows the summary, syntax, since and complexity |
| 6.3 | Press Ctrl+Enter on a line, or on a selection. | Runs only that line or selection. F5 / Ctrl+Shift+Enter runs every line, skipping blanks and `#` / `//` comments |
| 6.4 | Look at the result cards. | Each shows the echo, db and elapsed ms. Text is rendered like redis-cli. `HGETALL` / `CONFIG GET` / `ZRANGE … WITHSCORES` / `XINFO GROUPS` open as a table. JSON bulk replies are pretty-printed. Copy copies the result. Errors appear in red |
| 6.5 | Run `SELECT 2` then `DBSIZE`. | The DB selector follows to db2, and later runs use db2 |
| 6.6 | Run `MONITOR`, `SUBSCRIBE x`, `QUIT`, `AUTH x` or `CLIENT SETNAME y`. | Refused before anything in the batch runs, with a hint (Info › Monitor, the Pub/Sub tab, "would change the shared connection") |
| 6.7 | Run `MULTI` / `SET t 1` / `INCR t` / `EXEC`, and `BLPOP q 5` in another tab while pushing to `q`. | The transaction runs on a dedicated connection (QUEUED…, then the EXEC array). BLPOP does not block the browser or other tabs |
| 6.8 | Open the CLI tab and run `SET k "a b"` then `GET k`. | The prompt is `host:port>`, or `host:port[2]>` after SELECT 2. The output is `"a b"`. `help ZADD` prints the docs and `clear` clears |
| 6.9 | Use the CLI keys: Tab, ↑ / ↓ (or Ctrl+↑ / Ctrl+↓). | Tab opens completion, and Tab/Enter accepts. The arrows walk the history, which keeps 200 entries per connection and survives a reload |

## 7. Pub/Sub, Slowlog, Info, MONITOR, Analysis (§5.5)
| # | Step | Expected |
|---|---|---|
| 7.1 | In Pub/Sub, add `news` and `orders.*` (a glob becomes a pattern) and click Subscribe. | The status shows Live. Messages arrive newest first with time, channel and pattern. Clicking a JSON message pretty-prints it |
| 7.2 | Publish to `news`. | A toast shows the receiver count, and the message appears in the list |
| 7.3 | Pause, then Resume. Publish fast (`redis-benchmark -t publish`). | While paused, messages are dropped and the "dropped N" badge shows. Filter and Clear work. Unsubscribe ends the stream (`GET /streams` no longer lists it) |
| 7.4 | Look at the Active channels side list. | PUBSUB CHANNELS with subscriber counts. Clicking a channel adds it |
| 7.5 | Open Slowlog. | A grid of id, time, duration, command and client, sortable by duration. "Auto-refresh 5 s" works. Changing *Slower than (µs)* asks before CONFIG SET. Reset asks before SLOWLOG RESET. Writes are disabled when read-only |
| 7.6 | Open Info. | Tiles for used memory / peak / fragmentation, ops/sec, clients, hit ratio, keys, uptime and role + replicas. Sparklines update every 2 s and keep 60 samples. Searching INFO filters every section |
| 7.7 | Info → Clients → Kill. | A danger confirmation with `CLIENT KILL ID n`. The row disappears |
| 7.8 | Info → Monitor → **Start MONITOR**. | A warning about throughput and the auto-stop time (1–60 min) appears first. Lines stream (`[db client] SET …`), with Pause and Stop. When the queue overflows, "dropped N" shows. When the time runs out, "MONITOR stopped automatically" |
| 7.9 | Open Analysis and click Analyze with 100k on the real 10k-key seed. | The job progress shows "Analysed n of m keys", and **Cancel** works. It finishes in under 30 s for 100k keys. Results: keys analysed, memory, % with TTL, duration; memory by type as a stacked bar; namespaces (first and second level, sortable by memory or keys, expandable); top 100 keys (a click opens the browser); TTL buckets. Re-run, JSON and CSV export |

## 8. Read-only and keyboard
| # | Step | Expected |
|---|---|---|
| 8.1 | Mark the connection read-only. | The browser shows the lock pill. **+ Key**, Rename, TTL, Delete and every editor's Add/Save are disabled. The Workbench allows only read commands: `SET` returns 403 `READ_ONLY` naming the command. PUBLISH, CONFIG SET, SLOWLOG RESET, CLIENT KILL and delete-by-pattern are refused |
| 8.2 | Check that every action is a command (Ctrl+Shift+P, type "Redis"). | Browser, Workbench, CLI, Pub/Sub, Slowlog, Info, MONITOR…, Analysis, New key…, Rename…, Set TTL…, Delete…, Delete keys matching…, Flush database…, Copy…, Rescan, Scan more, Save value changes… are all listed |
| 8.3 | Check shortcuts. | In the key list: F2 rename, Delete delete, Insert new key. In the browser: Ctrl+F pattern, Alt+← / Alt+→ panes, F5 rescan (local), Ctrl+S save (local). In the Workbench: Ctrl+Enter / F5 (Monaco). In the CLI: Tab, ↑ ↓, Ctrl+↑ ↓. There are no conflicts in the shortcut sheet |

Deviations from the plan's key list (§5.3), so that no scoped shortcut shadows a global one (`commands.test.ts`):
- New key is **Insert** instead of Ctrl+N, which opens a console.
- Panes are **Alt+← / Alt+→** instead of Alt+1 / Alt+2, which focus the explorer and the editor.
- F5 and Ctrl+S are handled by the browser view, not bound in the registry.
