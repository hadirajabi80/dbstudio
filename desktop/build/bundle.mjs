// Bundles main and preload with esbuild (type checking is done by `tsc --noEmit` first).
// Also emits electron-free modules under out/lib for the Node tests in test/.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
rmSync(out, { recursive: true, force: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: 'linked',
  logLevel: 'warning',
  legalComments: 'none',
};

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'out/main.js' }),
  // Sandboxed preload: a single file whose only runtime require is `electron`.
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'out/preload.js' }),
  build({
    ...common,
    entryPoints: ['src/main/engine-process.ts', 'src/main/validate.ts', 'src/main/fs-utils.ts', 'src/main/csp.ts'],
    outdir: 'out/lib',
    sourcemap: false,
  }),
]);

console.log('desktop: bundled out/main.js, out/preload.js, out/lib/*');
