// M2-L: engine error toasts (engine.log level error, engine restarted) offer "Open engine log".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCommand, registerCommand } from '../commands/registry';
import { openEngineLogAction } from './boot';

describe('Open engine log toast action', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('runs logs.openEngineLog when the Logs package is loaded', () => {
    const run = vi.fn();
    if (!getCommand('logs.openEngineLog')) dispose = registerCommand({ id: 'logs.openEngineLog', title: 'Open engine log', category: 'Logs', run });
    const action = openEngineLogAction();
    expect(action?.label).toBe('Open engine log');
    action!.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is absent without the command', () => {
    if (getCommand('logs.openEngineLog')) return;
    expect(openEngineLogAction()).toBeUndefined();
  });
});
