// features-01: F4 "Edit:" consoles on SQLite (views, triggers) run through POST /designer/apply with
// transactional:true, so a failing CREATE rolls the DROP back and the object keeps its definition.
import { beforeEach, describe, expect, it } from 'vitest';
import { runEditTab } from '../designer/editRun';
import { useDesignerUi } from '../designer/store';
import { useConnections } from '../store/connections';
import { useResults } from '../store/results';
import { useSessions } from '../store/sessions';
import { useTabs } from '../store/tabs';
import { useUi } from '../store/ui';
import { installMockEngine } from '../test/mockServer';
import { runInTab } from './actions';

const mock = installMockEngine({ frameDelay: 0 });

const ref = { database: null, schema: 'main', name: 'TR_OrderLines_Insert', type: 'trigger' as const };
const DDL = 'CREATE TRIGGER TR_OrderLines_Insert AFTER INSERT ON order_lines BEGIN UPDATE orders SET total = total WHERE id = NEW.order_id; END;';

function editTab(text: string): string {
  const id = useTabs.getState().newConsole({ connectionId: 'c_shop', text, title: 'Edit: TR_OrderLines_Insert' });
  useDesignerUi.getState().registerEdit(id, { connectionId: 'c_shop', database: null, ref, serverDdl: DDL, dialect: 'sqlite' });
  return id;
}

describe('atomic SQLite edit scripts', () => {
  beforeEach(async () => {
    useTabs.setState({ tabs: [], activeId: null, seq: 0, mru: [], closed: [] });
    useSessions.setState({ sessions: {}, byTab: {} });
    useUi.setState({ confirm: null, toasts: [] });
    await useConnections.getState().load();
  });

  it('a broken CREATE leaves the object intact: one transactional apply, nothing executed statement by statement', async () => {
    const applies: { statements: string[]; transactional: boolean }[] = [];
    const listener = ({ request }: { request: Request }) => {
      if (request.method === 'POST' && request.url.endsWith('/designer/apply')) void request.clone().json().then((b) => applies.push(b as never));
    };
    mock.server.events.on('request:start', listener);
    const id = editTab(`DROP TRIGGER IF EXISTS TR_OrderLines_Insert;\n${DDL.replace('BEGIN', 'BEGINX')}`);

    expect(await runEditTab(id)).toBe(true);

    expect(applies).toHaveLength(1);
    expect(applies[0].transactional).toBe(true);
    // DROP + the broken CREATE (which the splitter may cut at the inner ';' once BEGIN is misspelt).
    expect(applies[0].statements.length).toBeGreaterThanOrEqual(2);
    expect(applies[0].statements[0]).toMatch(/^DROP TRIGGER/);
    expect(mock.hits('/execute', 'POST')).toHaveLength(0);
    const exec = useResults.getState().executions[useResults.getState().byTab[id]];
    expect(exec.status).toBe('error');
    expect(exec.messages.map((m) => m.text).join('\n')).toMatch(/Statement \d+ failed[\s\S]*rolled back[\s\S]*keeps its previous definition/);
    expect(useUi.getState().toasts.at(-1)?.text).toBe('TR_OrderLines_Insert was not changed');
    mock.server.events.removeListener('request:start', listener);
  });

  it('a valid script is applied in one transaction and reported in the console', async () => {
    const id = editTab(`DROP TRIGGER IF EXISTS TR_OrderLines_Insert;\n${DDL}`);
    expect(await runEditTab(id)).toBe(true);
    const exec = useResults.getState().executions[useResults.getState().byTab[id]];
    expect(exec.status).toBe('ok');
    expect(exec.messages.some((m) => /in one transaction/.test(m.text))).toBe(true);
  });

  it('runInTab routes edit tabs through the atomic apply; other consoles run normally', async () => {
    const id = editTab(`DROP TRIGGER IF EXISTS TR_OrderLines_Insert;\n${DDL}`);
    await runInTab(id, 'script', [{ sql: 'DROP TRIGGER IF EXISTS TR_OrderLines_Insert', line: 1, col: 1 }]);
    expect(mock.hits('/designer/apply', 'POST')).toHaveLength(1);
    expect(mock.hits('/execute', 'POST')).toHaveLength(0);

    // Not an edit of a view/trigger (or another connection): false, the caller runs it as usual.
    const plain = useTabs.getState().newConsole({ connectionId: 'c_shop', text: 'SELECT 1' });
    expect(await runEditTab(plain)).toBe(false);
  });
});
