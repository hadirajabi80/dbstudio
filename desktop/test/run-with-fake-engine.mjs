// `npm run start:fake`: runs the app against test/fake-engine.mjs (no .NET needed).
// Uses ui/dist when it has been built, otherwise the tiny fixture UI. Extra args go to the fake engine,
// e.g. `npm run start:fake -- --exit-after 5000` to see the restart dialog.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { desktopRoot, fakeEngine } from './helpers.mjs';

const require = createRequire(import.meta.url);
const uiDist = join(desktopRoot, '..', 'ui', 'dist');
const env = {
  ...process.env,
  DBSTUDIO_ENGINE_CMD: [`"${process.execPath}"`, `"${fakeEngine}"`, ...process.argv.slice(2)].join(' '),
  DBSTUDIO_UI_DIR: process.env.DBSTUDIO_UI_DIR ?? (existsSync(join(uiDist, 'index.html')) ? uiDist : join(desktopRoot, 'test', 'fixture-ui')),
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [desktopRoot], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
