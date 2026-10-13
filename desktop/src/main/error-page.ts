// Static page shown when the engine cannot be started. Rendered from a data: URL (no scripts, no bridge).

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function engineErrorPageUrl(o: { message: string; output: string[]; logFile: string; dark: boolean }): string {
  const bg = o.dark ? '#1e1e1e' : '#ffffff';
  const fg = o.dark ? '#d4d4d4' : '#1f2328';
  const muted = o.dark ? '#9da1a6' : '#59636e';
  const panel = o.dark ? '#252526' : '#f6f8fa';
  const tail = o.output.slice(-25).join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>DbStudio - engine failed to start</title>
<style>
  body { margin: 0; background: ${bg}; color: ${fg}; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  main { max-width: 760px; margin: 12vh auto 0; padding: 0 24px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 8px 0; color: ${muted}; }
  code, pre { font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; }
  pre { background: ${panel}; padding: 12px 14px; border-radius: 6px; overflow: auto; max-height: 40vh; white-space: pre-wrap; }
</style></head><body><main>
  <h1>The DbStudio engine could not be started</h1>
  <p>${esc(o.message)}</p>
  ${tail ? `<pre>${esc(tail)}</pre>` : ''}
  <p>Engine log: <code>${esc(o.logFile)}</code></p>
  <p>Use the dialog to retry, or Help &rsaquo; Open Logs Folder.</p>
</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
