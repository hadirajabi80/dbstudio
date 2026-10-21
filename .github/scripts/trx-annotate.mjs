// Emits a GitHub Actions error annotation for every failed test in the .trx files under a folder, so failures are
// readable from the checks API without downloading logs or artifacts.
// Usage: node .github/scripts/trx-annotate.mjs TestResults
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'TestResults';
const files = [];
(function walk(d) {
  let entries = [];
  try { entries = readdirSync(d); } catch { return; }
  for (const e of entries) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.trx')) files.push(p);
  }
})(dir);

const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A');
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
let failed = 0;
for (const f of files) {
  const xml = readFileSync(f, 'utf8');
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*)>([\s\S]*?)<\/UnitTestResult>/g)) {
    if (!/outcome="Failed"/.test(m[1])) continue;
    failed++;
    const name = decode(/testName="([^"]*)"/.exec(m[1])?.[1] ?? '?');
    const message = decode(/<Message>([\s\S]*?)<\/Message>/.exec(m[2])?.[1] ?? '').trim();
    const stack = decode(/<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(m[2])?.[1] ?? '').trim().split('\n').slice(0, 4).join('\n');
    if (failed <= 10) console.log(`::error title=${esc(name.slice(0, 200))}::${esc(`${message}\n${stack}`.slice(0, 3000))}`);
  }
}
console.log(`${files.length} trx file(s), ${failed} failed test(s)${failed > 10 ? ' (first 10 annotated)' : ''}`);
