// Compile checks of the Go and TypeScript codegen snapshots (the C# ones are compiled by Codegen.Smoke.csproj).
//   node engine/tests/Codegen.Smoke/check-go-ts.mjs
// Go: `go vet` of every Go snapshot (one package per file) with sqlx, go-mssqldb and pgx/v5 from the module proxy; godror needs
// cgo, so a stub with its real WrapRows/Querier signatures stands in. Skipped when `go` is not on PATH.
// TypeScript: `tsc --noEmit --strict` against @types/mssql, @types/oracledb, @types/better-sqlite3, @types/pg and zod, installed
// with --ignore-scripts into a temp folder (needs network). Exit code 1 on any failure.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const snaps = join(root, 'ui/src/codegen/__tests__/__snapshots__');
const work = mkdtempSync(join(tmpdir(), 'dbstudio-codegen-'));
let failed = false;
const run = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    failed = true;
    console.error(`✗ ${cmd} ${args.join(' ')}\n${r.stdout}${r.stderr}`);
  } else console.log(`✓ ${cmd} ${args.join(' ')}`);
  return r.status === 0;
};

// ---------- Go ----------
const hasGo = spawnSync('go', ['version'], { shell: process.platform === 'win32' }).status === 0;
if (!hasGo) console.log('- go not found: Go check skipped');
else {
  const g = join(work, 'go');
  mkdirSync(join(g, 'stubs/godror'), { recursive: true });
  writeFileSync(join(g, 'go.mod'), 'module example.com/vet\n\ngo 1.24\n\nreplace github.com/godror/godror => ./stubs/godror\n');
  writeFileSync(join(g, 'stubs/godror/go.mod'), 'module github.com/godror/godror\n\ngo 1.24\n');
  writeFileSync(
    join(g, 'stubs/godror/stub.go'),
    'package godror\n\nimport (\n\t"context"\n\t"database/sql"\n\t"database/sql/driver"\n)\n\ntype Querier interface {\n\tQueryContext(context.Context, string, ...any) (*sql.Rows, error)\n}\n\nfunc WrapRows(ctx context.Context, q Querier, rset driver.Rows) (*sql.Rows, error) { return nil, nil }\n',
  );
  for (const f of readdirSync(join(snaps, 'go'))) {
    const dir = join(g, f.replace(/\W+/g, '_'));
    mkdirSync(dir);
    cpSync(join(snaps, 'go', f), join(dir, 'shop.go'));
  }
  // PostgreSQL snapshots: pgx/v5 (pgtype, pgxpool, and stdlib for database/sql + sqlx).
  run('go', ['get', 'github.com/jmoiron/sqlx', 'github.com/microsoft/go-mssqldb', 'github.com/godror/godror', 'github.com/jackc/pgx/v5', 'github.com/jackc/pgx/v5/pgxpool', 'github.com/jackc/pgx/v5/stdlib'], g, { GOFLAGS: '-mod=mod' });
  run('gofmt', ['-l', '.'], join(snaps, 'go'));
  run('go', ['vet', './...'], g, { CGO_ENABLED: '0' });
}

// ---------- TypeScript ----------
const t = join(work, 'ts');
mkdirSync(join(t, 'src'), { recursive: true });
writeFileSync(join(t, 'package.json'), '{"name":"codegen-ts-check","private":true}');
writeFileSync(
  join(t, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, esModuleInterop: true, skipLibCheck: true, noUnusedLocals: true, types: ['node'] }, include: ['src/**/*.ts'] }),
);
// The prisma flavor is a schema.prisma file, not TypeScript (`npx prisma validate` checks it).
for (const f of readdirSync(join(snaps, 'typescript')).filter((f) => !f.startsWith('prisma.'))) {
  const dir = join(t, 'src', f.replace(/\.ts\.snap$/, '').replace(/\W+/g, '_'));
  mkdirSync(dir);
  cpSync(join(snaps, 'typescript', f), join(dir, 'index.ts'));
}
// @types/pg: the node-postgres (pgsql) snapshots.
if (run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--silent', '@types/mssql@9', '@types/oracledb@6', '@types/better-sqlite3@7', '@types/pg@8', 'zod@3', '@types/node@24'], t)) {
  run('node', [join(root, 'ui/node_modules/typescript/bin/tsc'), '-p', '.'], t);
}

console.log(failed ? 'FAILED' : 'OK');
process.exit(failed ? 1 : 0);
