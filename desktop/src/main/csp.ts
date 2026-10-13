// Content-Security-Policy for the renderer. Electron-free (unit tested).
//
// - The engine lives on http://127.0.0.1:<random port> (REST) and ws://127.0.0.1:<port>/ws.
// - Monaco needs inline styles, its editor worker (same origin, or blob: in some bundler setups),
//   and data: fonts/images for codicons.
// - In dev the page comes from Vite, whose React Refresh preamble is an inline script and whose HMR
//   client connects back over ws://localhost:5173.

export const UI_ORIGIN = 'dbstudio://app';

export function buildCsp(devServerOrigin?: string): string {
  const dev = devServerOrigin ? new URL(devServerOrigin).origin : undefined;
  const devWs = dev ? dev.replace(/^http/, 'ws') : undefined;
  const engine = 'http://127.0.0.1:* ws://127.0.0.1:*';
  // Vite dev additionally talks to localhost (the dev engine on 5121 may be addressed as localhost).
  const devConnect = dev ? `${dev} ${devWs} http://localhost:* ws://localhost:*` : '';
  const directives: Record<string, string> = {
    'default-src': `'self' dbstudio:${dev ? ` ${dev}` : ''}`,
    'script-src': `'self' dbstudio: blob:${dev ? ` ${dev} 'unsafe-inline'` : ''}`,
    'worker-src': `'self' dbstudio: blob:${dev ? ` ${dev}` : ''}`,
    'style-src': `'self' dbstudio: 'unsafe-inline'${dev ? ` ${dev}` : ''}`,
    'img-src': `'self' dbstudio: data: blob:${dev ? ` ${dev}` : ''}`,
    'font-src': `'self' dbstudio: data:${dev ? ` ${dev}` : ''}`,
    'connect-src': `'self' dbstudio: ${engine}${devConnect ? ` ${devConnect}` : ''}`,
    'object-src': "'none'",
    'base-uri': "'self'",
    'form-action': "'none'",
    'frame-ancestors': "'none'",
  };
  return Object.entries(directives).map(([k, v]) => `${k} ${v}`).join('; ');
}
