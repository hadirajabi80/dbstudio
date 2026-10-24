// Dev Tools console text (Kibana style): requests are `METHOD /path` lines followed by an optional JSON (or NDJSON)
// body up to the next request line. `#` and `//` lines between requests are comments. Pure; lines are 1-based.

export const CONSOLE_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'] as const;
export type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

export interface ConsoleRequest {
  method: ConsoleMethod;
  path: string;
  /** Body text as typed (trimmed), '' when none. */
  body: string;
  /** Line of `METHOD /path`. */
  startLine: number;
  /** Last line of the request (body end; comment/blank lines after it are excluded). */
  endLine: number;
}

const REQUEST_LINE = /^\s*(GET|POST|PUT|DELETE|HEAD|PATCH)\s+(\S.*?)\s*$/i;
const COMMENT_LINE = /^\s*(#|\/\/)/;

export function isRequestLine(line: string): boolean {
  return REQUEST_LINE.test(line);
}

/** Normalises a typed path: `_cat/indices` → `/_cat/indices`. */
export function normalisePath(path: string): string {
  const p = path.trim();
  return p.startsWith('/') ? p : `/${p}`;
}

export function parseConsole(text: string): ConsoleRequest[] {
  const lines = text.split(/\r?\n/);
  const out: ConsoleRequest[] = [];
  let cur: { method: string; path: string; startLine: number; body: string[]; last: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const method = cur.method.toUpperCase();
    out.push({
      // PATCH parses (so it is not swallowed into the previous body) and the engine rejects it with a clear message
      method: method as ConsoleMethod,
      path: normalisePath(cur.path),
      body: cur.body.join('\n').trim(),
      startLine: cur.startLine,
      endLine: cur.last,
    });
    cur = null;
  };
  lines.forEach((line, i) => {
    const m = REQUEST_LINE.exec(line);
    if (m) {
      flush();
      cur = { method: m[1], path: m[2], startLine: i + 1, body: [], last: i + 1 };
      return;
    }
    if (!cur) return;
    // a comment line ends the body only when it is outside the JSON (column 0 `#`): keep `//` inside bodies
    if (COMMENT_LINE.test(line) && cur.body.every((b) => !b.trim())) return;
    cur.body.push(line);
    if (line.trim() && !COMMENT_LINE.test(line)) cur.last = i + 1;
  });
  flush();
  // bodies keep only lines up to the last non-blank, non-comment line
  return out.map((r) => {
    const bodyLines = r.body.split('\n');
    return { ...r, body: trimTrailingComments(bodyLines).join('\n').trim() };
  });
}

function trimTrailingComments(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (!lines[end - 1].trim() || COMMENT_LINE.test(lines[end - 1]))) end--;
  return lines.slice(0, end);
}

/** The request whose range contains `line` (or the closest one above it). */
export function requestAt(requests: readonly ConsoleRequest[], line: number): ConsoleRequest | null {
  let best: ConsoleRequest | null = null;
  for (const r of requests) if (r.startLine <= line) best = r;
  return best;
}

/** Requests overlapping the line range (selection run). */
export function requestsIn(requests: readonly ConsoleRequest[], from: number, to: number): ConsoleRequest[] {
  return requests.filter((r) => r.endLine >= from && r.startLine <= to);
}

/** Bulk-style endpoints take NDJSON bodies: each line its own JSON. */
export function isNdjsonPath(path: string): boolean {
  return /(^|\/)(_bulk|_msearch|_msearch\/template)(\?|$)/.test(path.replace(/^\//, ''));
}

/** Endpoints whose body is a search request (query DSL completion). */
export function isSearchPath(path: string): boolean {
  return /(^|\/)(_search|_count|_delete_by_query|_update_by_query|_validate\/query|_explain(\/[^/?]+)?|_async_search|_search\/template|_knn_search|_eql\/search)(\?|$)/.test(
    path.replace(/^\//, ''),
  );
}

/** Index (or pattern) a path targets: its first segment unless it starts with `_`. */
export function indexOfPath(path: string): string | null {
  const seg = path.replace(/^\//, '').split(/[/?]/)[0];
  return seg && !seg.startsWith('_') ? decodeURIComponent(seg) : null;
}

/** Body ready to send: NDJSON bodies keep one compact JSON per line; JSON bodies are sent as typed. */
export function bodyForSend(path: string, body: string, compact: (line: string) => string): string {
  if (!body.trim()) return '';
  if (!isNdjsonPath(path)) return body;
  return `${body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(compact).join('\n')}\n`;
}

/** `curl` equivalent of a request against `baseUrl`. */
export function toCurl(baseUrl: string, req: Pick<ConsoleRequest, 'method' | 'path' | 'body'>): string {
  const url = `${baseUrl.replace(/\/+$/, '')}${normalisePath(req.path)}`;
  const parts = [`curl -X${req.method} "${url}"`];
  if (req.body.trim()) {
    const type = isNdjsonPath(req.path) ? 'application/x-ndjson' : 'application/json';
    parts.push(`-H "Content-Type: ${type}"`, `-d '${req.body.replace(/'/g, "'\\''")}'`);
  }
  return parts.join(' \\\n  ');
}

/** Console text of one request (history entries, "Copy as console"). */
export function formatRequest(method: string, path: string, body?: unknown): string {
  const head = `${method.toUpperCase()} ${normalisePath(path)}`;
  if (body === undefined || body === null || body === '') return head;
  return `${head}\n${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`;
}
