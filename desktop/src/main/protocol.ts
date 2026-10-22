// dbstudio://app — serves the built UI (ui/dist) from a privileged custom origin (D-7), with explicit
// MIME types, an SPA fallback to index.html, and the CSP header on documents.
import { protocol } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCsp } from './csp';

export const SCHEME = 'dbstudio';
export const HOST = 'app';
export const UI_URL = `${SCHEME}://${HOST}/`;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
};

export function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Must run before app 'ready'. */
export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

/**
 * Maps a request path to a file under root, or null when it escapes root.
 * Exported for tests.
 */
export function resolveUnderRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = path.normalize(decoded.replace(/^\/+/, ''));
  const full = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile();
  } catch {
    return false;
  }
}

function notFound(text = 'Not found'): Response {
  return new Response(text, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function serveFile(file: string, csp: string): Promise<Response> {
  const body = await fs.promises.readFile(file);
  const type = mimeFor(file);
  const headers: Record<string, string> = {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    // Vite fingerprints everything under assets/; index.html must always be revalidated.
    'Cache-Control': /[\\/]assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (type.startsWith('text/html')) headers['Content-Security-Policy'] = csp;
  return new Response(new Uint8Array(body), { status: 200, headers });
}

export function registerUiProtocol(root: string): void {
  const csp = buildCsp();
  const resolvedRoot = path.resolve(root);
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return notFound();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const file = resolveUnderRoot(resolvedRoot, url.pathname);
    if (!file) return notFound();
    if (await isFile(file)) return serveFile(file, csp);
    // SPA fallback: extension-less routes (and the root) get index.html; missing assets stay 404.
    if (path.extname(url.pathname) === '' || url.pathname.endsWith('.html')) {
      const index = path.join(resolvedRoot, 'index.html');
      if (await isFile(index)) return serveFile(index, csp);
      return notFound(`Rowlit UI not found at ${resolvedRoot}. Run "npm run build" in ui/.`);
    }
    return notFound();
  });
}
