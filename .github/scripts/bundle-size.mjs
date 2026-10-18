#!/usr/bin/env node
// Bundle-size guard for the UI production build (code-p3, docs/PLAN-M1.5.md 5.5).
//
// Sums the gzipped size (zlib level 9, like a typical HTTP server) of every .js/.css/.html/.json/.svg/.wasm file under
// the dist folder and compares it with the committed baseline (.github/bundle-size-baseline.json). Fails when the
// bundle grew by more than the allowed budget (default 600 KB) over the baseline.
//
// The committed baseline is the M1 UI build (commit bfaac37), because PLAN-M1.5 5.5 limits growth over M1, not over
// the previous push. Do not re-baseline on the current tree to make a failing check pass: that silently widens the
// budget. To re-measure M1 (for example after a toolchain change), build that commit in a scratch folder:
//
//   git archive bfaac37 ui | tar -x -C <scratch>    then, in <scratch>/ui:  npm ci && npm run build
//   node .github/scripts/bundle-size.mjs --dist <scratch>/ui/dist --update
//
// Usage:
//   node .github/scripts/bundle-size.mjs [--dist ui/dist] [--baseline .github/bundle-size-baseline.json] [--budget-kb 600]
//   node .github/scripts/bundle-size.mjs --dist <dir> --update [--baseline <file>] [--note "<text>"]
//     rewrites the baseline from <dir>; the existing note (which build was measured) is kept unless --note is given.
//
// Exit codes: 0 within budget (or baseline updated), 1 over budget, 2 usage / missing dist or baseline.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, constants } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const dist = resolve(root, opt('--dist', 'ui/dist'));
const baselineFile = resolve(root, opt('--baseline', '.github/bundle-size-baseline.json'));
const budgetKb = Number(opt('--budget-kb', '600'));
const update = args.includes('--update');
const note = opt('--note', undefined);
const DEFAULT_NOTE = 'Gzipped size of ui/dist. Update with: node .github/scripts/bundle-size.mjs --dist <dir> --update.';
const measured = /\.(js|mjs|css|html|json|svg|wasm)$/i;

if (!Number.isFinite(budgetKb) || budgetKb < 0) {
  console.error(`Invalid --budget-kb: ${opt('--budget-kb', '')}`);
  process.exit(2);
}
if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No UI build at ${dist} (run "npm run build" in ui first).`);
  process.exit(2);
}

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else if (measured.test(entry.name)) out.push(full);
  }
  return out;
}

function gzipSize(file) {
  return new Promise((ok, fail) => {
    let size = 0;
    createReadStream(file)
      .pipe(createGzip({ level: constants.Z_BEST_COMPRESSION }))
      .on('data', (chunk) => { size += chunk.length; })
      .on('end', () => ok(size))
      .on('error', fail);
  });
}

const list = files(dist);
let gzip = 0;
let raw = 0;
const perFile = [];
for (const f of list) {
  const g = await gzipSize(f);
  gzip += g;
  raw += statSync(f).size;
  perFile.push({ file: relative(dist, f).split(sep).join('/'), gzip: g });
}
perFile.sort((a, b) => b.gzip - a.gzip);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`UI bundle: ${list.length} files, ${kb(raw)} raw, ${kb(gzip)} gzipped`);
for (const { file, gzip: g } of perFile.slice(0, 8)) console.log(`  ${kb(g).padStart(10)}  ${file}`);

if (update) {
  // Keep the provenance note of an existing baseline unless a new one is given: it records which build was measured.
  let previousNote;
  try {
    previousNote = JSON.parse(readFileSync(baselineFile, 'utf8')).note;
  } catch {
    previousNote = undefined;
  }
  writeFileSync(baselineFile, JSON.stringify({
    gzipBytes: gzip,
    rawBytes: raw,
    files: list.length,
    note: note ?? (typeof previousNote === 'string' && previousNote ? previousNote : DEFAULT_NOTE),
  }, null, 2) + '\n');
  console.log(`Baseline written to ${relative(root, baselineFile)}.`);
  process.exit(0);
}

if (!existsSync(baselineFile)) {
  console.error(`Baseline ${baselineFile} is missing; create it with --update and commit it.`);
  process.exit(2);
}
let baseline;
try {
  baseline = JSON.parse(readFileSync(baselineFile, 'utf8'));
} catch (e) {
  console.error(`Baseline ${baselineFile} is not valid JSON: ${e.message}`);
  process.exit(2);
}
if (!Number.isFinite(baseline?.gzipBytes) || baseline.gzipBytes <= 0) {
  console.error(`Baseline ${baselineFile} has no positive "gzipBytes".`);
  process.exit(2);
}
const growth = gzip - baseline.gzipBytes;
const budget = budgetKb * 1024;
if (baseline.note) console.log(`Baseline: ${baseline.note}`);
console.log(`Baseline ${kb(baseline.gzipBytes)} gzipped; change ${growth >= 0 ? '+' : ''}${kb(growth)} (budget +${budgetKb} KB).`);
if (growth > budget) {
  console.error(`::error::The gzipped UI bundle grew by ${kb(growth)}, more than the ${budgetKb} KB budget over the baseline. `
    + 'Split, lazy-load or trim the new code. The baseline is the M1 build (PLAN-M1.5 5.5); do not re-baseline on this tree.');
  process.exit(1);
}
