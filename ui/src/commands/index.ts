// Command bootstrap: registers the shell's commands and auto-loads every package's `commands.ts`
// (ui/src/<pkg>/commands.ts, ui/src/<pkg>/<sub>/commands.ts, ui/src/components/<Comp>/commands.ts).
//
// A package's commands.ts may register on import (side effect), or export any of:
//   - a zero-argument function `register`, `default`, or `register…Commands` (called once),
//   - an array `commands` / `COMMANDS` of Command objects.
import { registerCoreCommands } from './core';
import { commandRegistry, registerCommand, type Command } from './registry';

const modules = import.meta.glob(
  ['../*/commands.ts', '../*/*/commands.ts', '../components/*/commands.ts', '!../app/commands.ts', '!../intel/**', '!../commands/**'],
) as Record<string, () => Promise<Record<string, unknown>>>;

let initialised: Promise<void> | null = null;
const loaded: string[] = [];
const failed: string[] = [];

function isCommand(x: unknown): x is Command<never> {
  return !!x && typeof x === 'object' && typeof (x as Command).id === 'string' && typeof (x as Command).run === 'function';
}

function wireModule(path: string, mod: Record<string, unknown>) {
  for (const [name, value] of Object.entries(mod)) {
    try {
      if (typeof value === 'function' && value.length === 0 && (name === 'default' || name === 'register' || /^register\w*Commands$/.test(name))) {
        (value as () => unknown)();
      } else if ((name === 'commands' || name === 'COMMANDS') && Array.isArray(value)) {
        for (const c of value) if (isCommand(c)) registerCommand(c);
      }
    } catch (e) {
      console.error(`[commands] ${path}: ${name} failed`, e);
    }
  }
  loaded.push(path.replace(/^\.\.\//, 'src/'));
}

/**
 * Idempotent. Called once at startup (main.tsx awaits it before rendering) and by tests. Package modules load in
 * parallel; a module that fails to load (e.g. a package mid-edit) is reported and skipped instead of breaking the
 * whole shell.
 */
export function initCommands(): Promise<void> {
  if (initialised) return initialised;
  registerCoreCommands();
  initialised = (async () => {
    const results = await Promise.allSettled(Object.entries(modules).map(async ([path, load]) => [path, await load()] as const));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') wireModule(r.value[0], r.value[1]);
      else {
        const path = Object.keys(modules)[i];
        failed.push(path);
        console.error(`[commands] could not load ${path}`, r.reason);
      }
    });
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      const w = window as unknown as { __dbstudio?: Record<string, unknown> };
      w.__dbstudio = { ...(w.__dbstudio ?? {}), commands: commandRegistry, commandModules: loaded, failedCommandModules: failed };
    }
  })();
  return initialised;
}

/** Package command modules that were found (for diagnostics and tests). */
export function loadedCommandModules(): string[] {
  return [...loaded];
}

/** Modules that failed to load. */
export function failedCommandModules(): string[] {
  return [...failed];
}

export { commandRegistry };
