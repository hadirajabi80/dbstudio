// design-r1-08: menus draw an item in the danger colour from the command's explicit `danger` flag, not from its id.
// "Generate DELETE statement" only inserts text into the editor, so it is not red; Drop… and Truncate… are.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initCommands } from '../../commands';
import { CONTEXT_MENUS } from '../../commands/menuModel';
import { getCommand, registerCommand } from '../../commands/registry';
import { commandMenuItems } from './commandMenu';

beforeAll(() => initCommands(), 60_000);

const dangerOf = (command: string) => commandMenuItems([{ command }])[0]?.danger;

describe('danger items (design-r1-08)', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
  });

  it('explorer.generateDelete is not danger, explorer.drop is', () => {
    expect(getCommand('explorer.generateDelete')?.danger).toBeFalsy();
    expect(dangerOf('explorer.generateDelete')).toBe(false);
    expect(getCommand('explorer.drop')?.danger).toBe(true);
    expect(dangerOf('explorer.drop')).toBe(true);
  });

  it('commands that change data or delete something are flagged; Generate SQL items are not', () => {
    for (const id of ['explorer.drop', 'explorer.truncate', 'connections.delete', 'history.deleteEntry', 'history.clear', 'sessions.rollbackClose']) {
      expect(dangerOf(id), id).toBe(true);
    }
    for (const id of ['explorer.generateSelect', 'explorer.generateInsert', 'explorer.generateUpdate', 'explorer.generateDelete', 'connections.disconnect', 'explorer.copyDdl']) {
      expect(dangerOf(id), id).toBe(false);
    }
  });

  it('the Generate SQL submenu of a table has no danger item', () => {
    const gen = CONTEXT_MENUS['explorer.table'].find((e) => typeof e === 'object' && 'submenu' in e && e.submenu === 'explorer.generateSql');
    expect(gen).toBeDefined();
    const items = commandMenuItems(gen && typeof gen === 'object' && 'entries' in gen ? gen.entries : []);
    // hideDisabled items are hidden without a target; the SELECT one is always listed
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.danger)).toBe(false);
  });

  it('follows the flag, not the id', () => {
    off = registerCommand({ id: 'test.removeHighlight', title: 'Remove highlight', category: 'Test', run: () => undefined });
    expect(dangerOf('test.removeHighlight')).toBe(false);
    off();
    off = registerCommand({ id: 'test.purge', title: 'Purge', category: 'Test', danger: true, run: () => undefined });
    expect(dangerOf('test.purge')).toBe(true);
  });
});
