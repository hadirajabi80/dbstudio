#!/usr/bin/env node
// Checks the electron-updater metadata before a release is published (release.yml). electron-updater downloads
// https://github.com/<owner>/<repo>/releases/download/v<version>/<url> for every `url:` (and the legacy `path:`) in
// latest.yml / latest-mac.yml, plus "<url>.blockmap" for differential downloads, so each of those names must be an
// uploaded asset, and the version in the file must match the tag.
//
// Usage: node .github/scripts/check-update-info.mjs <dir> [--tag v1.2.3] [--require latest.yml,latest-mac.yml]
// Exit codes: 0 ok, 1 a referenced file is missing or the version does not match, 2 usage / no metadata.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dir || !existsSync(dir)) { console.error('usage: check-update-info.mjs <dir> [--tag vX.Y.Z] [--require a.yml,b.yml]'); process.exit(2); }
const tag = opt('tag');
const required = (opt('require') ?? '').split(',').filter(Boolean);

const files = new Set(readdirSync(dir));
const metadata = [...files].filter((f) => /^latest(-mac)?\.yml$/.test(f));
const errors = [];
for (const r of required) if (!files.has(r)) errors.push(`${r} is missing`);
if (!metadata.length) { console.error(`no latest*.yml in ${dir}`); process.exit(2); }

for (const name of metadata) {
  const text = readFileSync(join(dir, name), 'utf8');
  // Flat electron-builder YAML: "version: x", "path: x" and "  - url: x" / "    url: x" lines; values may be quoted.
  const value = (line) => line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
  const lines = text.split(/\r?\n/);
  const version = lines.filter((l) => /^version:/.test(l)).map(value)[0];
  const refs = new Set(lines.filter((l) => /^\s*(-\s+)?url:/.test(l) || /^path:/.test(l)).map(value));
  if (!version) errors.push(`${name}: no version`);
  else if (tag && `v${version}` !== tag) errors.push(`${name}: version ${version} does not match tag ${tag}`);
  if (!refs.size) errors.push(`${name}: references no files`);
  for (const ref of refs) {
    if (/[\\/]|^https?:/i.test(ref)) errors.push(`${name}: ${ref} is not a bare asset name`);
    else if (!files.has(ref)) errors.push(`${name}: ${ref} is not among the release assets`);
    else if (/\.(exe|zip)$/i.test(ref) && !files.has(`${ref}.blockmap`)) errors.push(`${name}: ${ref}.blockmap is missing`);
  }
  console.log(`${name}: version ${version}, ${[...refs].join(', ')}`);
}

if (errors.length) {
  for (const e of errors) console.error(`::error title=update metadata::${e}`);
  process.exit(1);
}
console.log('update metadata ok');
