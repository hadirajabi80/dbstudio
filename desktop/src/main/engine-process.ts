// Engine sidecar lifecycle: resolve how to launch it, spawn it, parse the DBSTUDIO_READY handshake,
// kill the whole process tree on quit, and supervise unexpected exits (restart dialog via hooks).
//
// This module deliberately does not import `electron`: main.ts injects the dialogs, which keeps the
// lifecycle testable in plain Node against test/fake-engine.mjs.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { EngineInfo } from '../../../ui/src/platform/bridge';

export type { EngineInfo };

export const READY_PREFIX = 'DBSTUDIO_READY ';
/**
 * File names tried, in order, inside resources/engine on Windows. The build scripts publish the engine as
 * Rowlit.Engine.exe (the name Task Manager / Activity Monitor show); the older DbStudio.Engine.exe and the Host
 * project's own DbStudio.Host.exe are still accepted (builds made before the rename, ad-hoc publishes).
 */
export const ENGINE_EXE_CANDIDATES = ['Rowlit.Engine.exe', 'DbStudio.Engine.exe', 'DbStudio.Host.exe'];
/** macOS/Linux: the same apphost names without an extension. */
export const ENGINE_EXE_CANDIDATES_POSIX = ['Rowlit.Engine', 'DbStudio.Engine', 'DbStudio.Host'];
/** How long a POSIX engine gets to handle SIGTERM (roll back transactions, close sessions) before SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 3_000;

export function engineExeCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ENGINE_EXE_CANDIDATES : ENGINE_EXE_CANDIDATES_POSIX;
}

/**
 * POSIX: makes sure the engine apphost has its executable bits (a zip extracted by some tools, or a copy through a
 * FAT/NTFS volume, loses them). Best effort: a read-only bundle that is already executable is left alone.
 */
export function ensureExecutable(file: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return;
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    try {
      const mode = fs.statSync(file).mode;
      fs.chmodSync(file, mode | 0o755);
    } catch { /* missing file: spawn reports it */ }
  }
}
export const DEFAULT_READY_TIMEOUT_MS = 15_000;
/** `dotnet run` compiles first, which can take far longer than 15 s on a cold build. */
export const DOTNET_RUN_READY_TIMEOUT_MS = 180_000;

export interface EngineLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Needed only for .cmd/.bat commands. */
  shell?: boolean;
  readyTimeoutMs: number;
  /** Human-readable description used in errors and logs. */
  description: string;
}

/** Either spawn an engine, or attach to one that is already running (scripts/dev.ps1). */
export type EngineLaunch = { kind: 'spawn'; spec: EngineLaunchSpec } | { kind: 'external'; info: EngineInfo };

export interface ResolveLaunchOptions {
  isPackaged: boolean;
  /** process.resourcesPath */
  resourcesPath: string;
  /** Repository root in dev (E:\DbStudio). */
  repoRoot: string;
  /** Our pid, passed as --parent-pid so the engine exits if Electron dies without cleaning up. */
  parentPid: number;
  env: NodeJS.ProcessEnv;
  /** The renderer is served by Vite (http://localhost:5173), so the engine must allow that origin. */
  devServer: boolean;
  exists?: (p: string) => boolean;
  /** Defaults to process.platform (tests pass 'darwin' etc.). */
  platform?: NodeJS.Platform;
  /** Defaults to ensureExecutable (POSIX chmod +x when needed). */
  makeExecutable?: (file: string) => void;
}

/**
 * Splits a command line into argv. Double quotes group, backslashes are literal (Windows paths),
 * `""` inside quotes is a literal quote.
 */
export function parseCommandLine(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"') {
      if (inQuotes && cmd[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      has = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (inQuotes) throw new Error('Unterminated quote in command line');
  if (has) out.push(cur);
  return out;
}

function parseTimeout(env: NodeJS.ProcessEnv, fallback: number): number {
  const raw = env.DBSTUDIO_ENGINE_TIMEOUT_MS;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : fallback;
}

function isLoopbackHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]');
  } catch {
    return false;
  }
}

/**
 * Resolution order:
 *  1. DBSTUDIO_ENGINE_URL + DBSTUDIO_ENGINE_TOKEN: attach to a running engine (no spawn).
 *  2. DBSTUDIO_ENGINE_CMD: a full command line (e.g. `node test/fake-engine.mjs`).
 *  3. DBSTUDIO_ENGINE_PATH: path to a prebuilt engine exe (e.g. engine/publish/Rowlit.Engine.exe).
 *  4. Packaged: resources/engine/<DBSTUDIO_ENGINE_EXE or a candidate name> (Rowlit.Engine.exe on Windows,
 *     Rowlit.Engine on macOS/Linux, i.e. Rowlit.app/Contents/Resources/engine/Rowlit.Engine).
 *  5. Dev: `dotnet run --project engine/src/DbStudio.Host --no-launch-profile -- ...`.
 * In every spawn case `--parent-pid <pid>` is appended (plus `--dev` when the UI comes from Vite).
 */
export function resolveEngineLaunch(o: ResolveLaunchOptions): EngineLaunch {
  const env = o.env;
  const exists = o.exists ?? ((p: string) => fs.existsSync(p));
  const platform = o.platform ?? process.platform;
  const makeExecutable = o.makeExecutable ?? ((p: string) => ensureExecutable(p, platform));

  if (env.DBSTUDIO_ENGINE_URL) {
    const url = env.DBSTUDIO_ENGINE_URL.replace(/\/+$/, '');
    if (!isLoopbackHttpUrl(url)) throw new Error(`DBSTUDIO_ENGINE_URL must be an http loopback URL, got "${url}"`);
    if (!env.DBSTUDIO_ENGINE_TOKEN) throw new Error('DBSTUDIO_ENGINE_URL is set but DBSTUDIO_ENGINE_TOKEN is not');
    return { kind: 'external', info: { baseUrl: url, token: env.DBSTUDIO_ENGINE_TOKEN } };
  }

  const extra = ['--parent-pid', String(o.parentPid), ...(o.devServer ? ['--dev'] : [])];

  if (env.DBSTUDIO_ENGINE_CMD) {
    const argv = parseCommandLine(env.DBSTUDIO_ENGINE_CMD);
    if (argv.length === 0) throw new Error('DBSTUDIO_ENGINE_CMD is empty');
    const [command, ...args] = argv;
    return {
      kind: 'spawn',
      spec: {
        command,
        args: [...args, ...extra],
        shell: /\.(cmd|bat)$/i.test(command),
        readyTimeoutMs: parseTimeout(env, DEFAULT_READY_TIMEOUT_MS),
        description: `DBSTUDIO_ENGINE_CMD (${env.DBSTUDIO_ENGINE_CMD})`,
      },
    };
  }

  if (env.DBSTUDIO_ENGINE_PATH) {
    const exe = path.resolve(env.DBSTUDIO_ENGINE_PATH);
    makeExecutable(exe);
    return {
      kind: 'spawn',
      spec: {
        command: exe,
        args: extra,
        cwd: path.dirname(exe),
        readyTimeoutMs: parseTimeout(env, DEFAULT_READY_TIMEOUT_MS),
        description: exe,
      },
    };
  }

  if (o.isPackaged) {
    const dir = path.join(o.resourcesPath, 'engine');
    const names = env.DBSTUDIO_ENGINE_EXE ? [env.DBSTUDIO_ENGINE_EXE] : engineExeCandidates(platform);
    const exe = names.map((n) => path.join(dir, n)).find((p) => exists(p)) ?? path.join(dir, names[0]);
    makeExecutable(exe);
    return {
      kind: 'spawn',
      spec: { command: exe, args: extra, cwd: dir, readyTimeoutMs: parseTimeout(env, DEFAULT_READY_TIMEOUT_MS), description: exe },
    };
  }

  const project = path.join(o.repoRoot, 'engine', 'src', 'DbStudio.Host');
  return {
    kind: 'spawn',
    spec: {
      command: 'dotnet',
      args: ['run', '--project', project, '--no-launch-profile', '--', ...extra],
      cwd: o.repoRoot,
      env: { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
      readyTimeoutMs: parseTimeout(env, DOTNET_RUN_READY_TIMEOUT_MS),
      description: `dotnet run --project ${project}`,
    },
  };
}

/** Parses `DBSTUDIO_READY {"port":N,"token":"..."}`. Returns null for any other line. */
export function parseReadyLine(line: string): { port: number; token: string } | null {
  const trimmed = line.replace(/^\uFEFF/, '').trim();
  if (!trimmed.startsWith(READY_PREFIX)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed.slice(READY_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const { port, token } = payload as { port?: unknown; token?: unknown };
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
  return { port, token };
}

export interface KillDeps {
  platform?: NodeJS.Platform;
  /** process.kill; injected by tests. */
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Windows tree kill; injected by tests. */
  taskkill?: (pid: number) => void;
  /** Only signal the process group, never the single pid (after the leader was reaped its pid may be reused). */
  groupOnly?: boolean;
}

function taskkill(pid: number): void {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
}

/**
 * POSIX: sends a signal to the engine's whole process group (`kill(-pid)`; it is spawned detached, so it leads its
 * own group and its children inherit it), falling back to the single pid. Returns false when nothing was signalled
 * (the process is gone). Signal 0 only probes.
 */
export function signalProcessTree(pid: number, signal: NodeJS.Signals | 0, deps: KillDeps = {}): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const kill = deps.kill ?? ((p: number, s: NodeJS.Signals | 0) => { process.kill(p, s); });
  try {
    kill(-pid, signal);
    return true;
  } catch {
    if (deps.groupOnly) return false;
    try { kill(pid, signal); return true; } catch { return false; /* already gone */ }
  }
}

/**
 * Kills a process and all of its descendants immediately and synchronously (safe to call from before-quit and
 * process 'exit'): `taskkill /T /F` on Windows, SIGKILL to the process group elsewhere.
 * For a graceful stop on macOS/Linux use EngineProcess.stopAndWait(), which sends SIGTERM first.
 */
export function killProcessTree(pid: number, deps: KillDeps = {}): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if ((deps.platform ?? process.platform) === 'win32') {
    (deps.taskkill ?? taskkill)(pid);
    return;
  }
  signalProcessTree(pid, 'SIGKILL', deps);
}

export type EngineStartFailure = 'spawn' | 'timeout' | 'exit' | 'stopped';

export class EngineStartError extends Error {
  constructor(message: string, readonly kind: EngineStartFailure, readonly output: string[]) {
    super(message);
    this.name = 'EngineStartError';
  }
}

export interface EngineExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when we asked for it (stop / quit). */
  expected: boolean;
  /** True when the process had completed the READY handshake. */
  wasReady: boolean;
}

export interface EngineProcessEvents {
  ready: [EngineInfo];
  exit: [EngineExit];
  /** Every stdout/stderr line (the READY line is masked). */
  output: ['stdout' | 'stderr', string];
}

export interface EngineProcessOptions {
  spec: EngineLaunchSpec;
  /** Immediate tree kill (default killProcessTree). */
  killTree?: (pid: number) => void;
  /** POSIX graceful stop: signal the tree (default signalProcessTree). Not used on Windows. */
  signalTree?: (pid: number, signal: NodeJS.Signals) => boolean;
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** SIGTERM grace period before SIGKILL (POSIX). */
  killGraceMs?: number;
  /** POSIX: SIGKILL whatever is left in the process group after the leader exited (default: group-only kill). */
  reapGroup?: (pid: number) => void;
  /** Lines kept for error reports. */
  tailLines?: number;
}

/** One engine process. Not reusable: create a new one per start. */
export class EngineProcess extends EventEmitter<EngineProcessEvents> {
  private child: ChildProcess | null = null;
  private stopping = false;
  private readyInfo: EngineInfo | null = null;
  private exited = false;
  private readonly tail: string[] = [];
  private readonly killTree: (pid: number) => void;
  private readonly signalTree: (pid: number, signal: NodeJS.Signals) => boolean;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly opts: EngineProcessOptions) {
    super();
    this.killTree = opts.killTree ?? ((pid) => killProcessTree(pid));
    this.signalTree = opts.signalTree ?? ((pid, sig) => signalProcessTree(pid, sig));
    this.platform = opts.platform ?? process.platform;
  }

  get pid(): number | undefined { return this.child?.pid; }
  get info(): EngineInfo | null { return this.readyInfo; }
  get isRunning(): boolean { return this.child !== null && !this.exited; }
  get recentOutput(): string[] { return [...this.tail]; }

  private remember(line: string) {
    this.tail.push(line);
    const max = this.opts.tailLines ?? 40;
    if (this.tail.length > max) this.tail.splice(0, this.tail.length - max);
  }

  start(): Promise<EngineInfo> {
    if (this.child) return Promise.reject(new Error('EngineProcess.start() called twice'));
    const { spec } = this.opts;

    return new Promise<EngineInfo>((resolve, reject) => {
      let settled = false;
      const fail = (message: string, kind: EngineStartFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new EngineStartError(message, kind, this.recentOutput));
      };

      let child: ChildProcess;
      try {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          shell: spec.shell ?? false,
          // POSIX: own process group so the whole tree can be signalled (kill -TERM -pid). Windows: taskkill /T.
          detached: process.platform !== 'win32',
        });
      } catch (e) {
        this.exited = true;
        reject(new EngineStartError(`Could not start the engine (${spec.description}): ${(e as Error).message}`, 'spawn', []));
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        fail(`The engine did not report ready within ${Math.round(spec.readyTimeoutMs / 1000)} s (${spec.description}).`, 'timeout');
        this.stop();
      }, spec.readyTimeoutMs);

      // stdout must be drained for the whole lifetime of the process, otherwise the pipe fills and the engine blocks.
      readline.createInterface({ input: child.stdout!, crlfDelay: Infinity }).on('line', (line) => {
        if (!this.readyInfo) {
          const ready = parseReadyLine(line);
          if (ready) {
            this.readyInfo = { baseUrl: `http://127.0.0.1:${ready.port}`, token: ready.token };
            this.emit('output', 'stdout', `${READY_PREFIX}{"port":${ready.port},"token":"<redacted>"}`);
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              this.emit('ready', this.readyInfo);
              resolve(this.readyInfo);
            }
            return;
          }
        }
        this.remember(line);
        this.emit('output', 'stdout', line);
      });
      readline.createInterface({ input: child.stderr!, crlfDelay: Infinity }).on('line', (line) => {
        this.remember(line);
        this.emit('output', 'stderr', line);
      });
      // Never write to stdin; keeping it open lets the engine treat EOF as "parent gone" if it wants to.
      child.stdin?.on('error', () => undefined);

      child.once('error', (err) => {
        // ENOENT etc. 'exit' may not follow, so settle here.
        this.exited = true;
        fail(`Could not start the engine (${spec.description}): ${err.message}`, 'spawn');
      });

      child.once('exit', (code, signal) => {
        this.exited = true;
        const wasReady = this.readyInfo !== null;
        if (!settled) {
          fail(
            this.stopping
              ? 'The engine was stopped before it became ready.'
              : `The engine exited before it became ready (exit code ${code ?? signal}).`,
            this.stopping ? 'stopped' : 'exit',
          );
        }
        this.emit('exit', { code, signal, expected: this.stopping, wasReady });
      });
    });
  }

  /** Kills the process tree synchronously. Idempotent. */
  stop(): void {
    this.stopping = true;
    const pid = this.child?.pid;
    if (pid && !this.exited) this.killTree(pid);
  }

  /**
   * Stops the tree and waits for the 'exit' event (bounded).
   * Windows: immediate `taskkill /T /F` (unchanged). macOS/Linux: SIGTERM to the process group so the engine can
   * roll back open transactions and close sessions, then SIGKILL to whatever is left after the grace period.
   */
  async stopAndWait(timeoutMs = 10_000): Promise<void> {
    if (!this.child || this.exited) { this.stopping = true; return; }
    const exited = new Promise<void>((r) => this.child!.once('exit', () => r()));
    const pid = this.child.pid;
    const wait = (ms: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      void exited.then(() => { clearTimeout(timer); resolve(true); });
    });
    if (this.platform === 'win32' || !pid) {
      this.stop();
      await wait(timeoutMs);
      return;
    }
    this.stopping = true;
    const grace = Math.min(this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS, timeoutMs);
    if (this.signalTree(pid, 'SIGTERM') && (await wait(grace))) {
      // The leader exited; take down grandchildren that ignored SIGTERM. Group only: the pid may be reused now.
      (this.opts.reapGroup ?? ((p: number) => { signalProcessTree(p, 'SIGKILL', { groupOnly: true }); }))(pid);
      return;
    }
    this.killTree(pid);
    await wait(Math.max(0, timeoutMs - grace));
  }
}

export interface SupervisorHooks {
  /** Engine died while running. Resolve true to restart, false to give up (main quits the app). */
  askRestart(exit: EngineExit, recentOutput: string[]): Promise<boolean>;
  /** A restart succeeded; main forwards the info to the renderer (onEngineRestarted). */
  onRestarted(info: EngineInfo): void;
  /** Starting (or restarting) failed. */
  onStartFailed(err: Error): void;
  /** The user chose not to restart. */
  onGaveUp(): void;
  onOutput?(stream: 'stdout' | 'stderr', line: string): void;
  onExit?(exit: EngineExit): void;
}

interface Deferred<T> { promise: Promise<T>; settled: boolean; resolve(v: T): void; reject(e: Error): void }
function deferred<T>(): Deferred<T> {
  let res!: (v: T) => void;
  let rej!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { res = a; rej = b; });
  promise.catch(() => undefined); // a rejected start must not be an unhandled rejection
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve: (v) => { d.settled = true; res(v); },
    reject: (e) => { d.settled = true; rej(e); },
  };
  return d;
}

/**
 * Owns the current engine and the "engine info" promise handed to the renderer.
 * getEngineInfo() calls made while the engine is starting or restarting wait for it.
 */
export class EngineSupervisor {
  private current: EngineProcess | null = null;
  private ready: Deferred<EngineInfo> = deferred();
  private shuttingDown = false;
  private restarting = false;

  constructor(
    private readonly launch: EngineLaunch,
    private readonly hooks: SupervisorHooks,
    private readonly createProcess: (spec: EngineLaunchSpec) => EngineProcess = (spec) => new EngineProcess({ spec }),
  ) {}

  get pid(): number | undefined { return this.current?.pid; }
  get isExternal(): boolean { return this.launch.kind === 'external'; }

  whenReady(): Promise<EngineInfo> { return this.ready.promise; }

  /** Starts the engine (also used for "Retry" after a failure). */
  async start(): Promise<EngineInfo> {
    if (this.launch.kind === 'external') {
      this.ready.resolve(this.launch.info);
      return this.launch.info;
    }
    if (this.ready.settled) this.ready = deferred(); // a (re)start invalidates the previous info
    const pending = this.ready; // whoever is waiting gets this start's outcome
    if (this.current?.isRunning) await this.current.stopAndWait();
    const proc = this.createProcess(this.launch.spec);
    this.current = proc;
    proc.on('output', (s, l) => this.hooks.onOutput?.(s, l));
    proc.on('exit', (exit) => this.handleExit(proc, exit));
    try {
      const info = await proc.start();
      pending.resolve(info);
      return info;
    } catch (e) {
      pending.reject(e as Error); // the next start() replaces the settled promise
      if (!this.shuttingDown) this.hooks.onStartFailed(e as Error);
      throw e;
    }
  }

  private async handleExit(proc: EngineProcess, exit: EngineExit) {
    this.hooks.onExit?.(exit);
    if (proc !== this.current || exit.expected || !exit.wasReady || this.shuttingDown || this.restarting) return;
    // Unexpected death of a healthy engine: new callers of whenReady() wait for the restart.
    this.ready = deferred();
    this.restarting = true;
    try {
      const restart = await this.hooks.askRestart(exit, proc.recentOutput);
      if (this.shuttingDown) return;
      if (!restart) { this.hooks.onGaveUp(); return; }
      const info = await this.start();
      this.hooks.onRestarted(info);
    } catch {
      /* onStartFailed already reported it */
    } finally {
      this.restarting = false;
    }
  }

  /** Synchronous tree kill, for before-quit and process 'exit'. */
  shutdown(): void {
    this.shuttingDown = true;
    this.current?.stop();
  }

  /** Graceful variant used when quitting on macOS/Linux: SIGTERM, bounded wait, then SIGKILL (see stopAndWait). */
  async shutdownGracefully(timeoutMs = 5_000): Promise<void> {
    this.shuttingDown = true;
    if (this.current?.isRunning) await this.current.stopAndWait(timeoutMs);
  }

  /** Test helper and "kill engine" debugging aid: kill without marking it expected. */
  simulateCrash(): void {
    const pid = this.current?.pid;
    if (pid) killProcessTree(pid);
  }
}
