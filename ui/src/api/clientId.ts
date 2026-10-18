// Identity of this UI window towards the engine (B1, logic-08). Sent as `X-DbStudio-Client` on every REST call and as
// `clientId` in the WebSocket auth frame. Sessions belong to the window that created or last used them; when its
// WebSocket stays closed longer than settings `connections.orphanGraceSeconds` (default 90 s) the engine closes them
// (rolling back open transactions). Kept in sessionStorage so a page reload keeps the same id (and its sessions).

export const CLIENT_ID_HEADER = 'X-DbStudio-Client';

const STORAGE_KEY = 'dbstudio.clientId';
let cached: string | null = null;

function randomId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Stable id of this window (printable ASCII, at most 128 chars, as the engine requires). */
export function uiClientId(): string {
  if (cached) return cached;
  let id: string | null = null;
  try {
    id = globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    id = null; // storage blocked: one id per page load
  }
  if (!id || !/^[!-~]{1,128}$/.test(id)) {
    id = randomId();
    try {
      globalThis.sessionStorage?.setItem(STORAGE_KEY, id);
    } catch {
      // not persisted; fine
    }
  }
  cached = id;
  return id;
}
