import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import { engineSocket } from '../../api/ws';
import { ENGINE_LOST_CODE, ENGINE_LOST_MESSAGE, runSql } from './runner';

/** Drives the private status setter the way a dropped socket does. */
const setStatus = (s: string) => (engineSocket as unknown as { setStatus(s: string): void }).setStatus(s);

describe('runSql: the wait for exec.done never hangs (features-24)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setStatus('open');
  });

  it('rejects with "connection lost" when the WebSocket drops mid-statement', async () => {
    setStatus('open');
    vi.spyOn(api, 'execute').mockResolvedValue({ executionId: 'x-lost' } as Awaited<ReturnType<typeof api.execute>>);
    vi.spyOn(api, 'cancel').mockResolvedValue({ cancelled: true });
    const p = runSql('s1', 'SELECT 1', []);
    await new Promise((r) => setTimeout(r, 10));
    setStatus('reconnecting');
    const out = await p;
    expect(out.status).toBe('error');
    expect(out.error).toMatchObject({ message: ENGINE_LOST_MESSAGE, code: ENGINE_LOST_CODE });
  });

  it('fails fast when the socket is already down after the execute call', async () => {
    setStatus('closed');
    vi.spyOn(api, 'execute').mockResolvedValue({ executionId: 'x-down' } as Awaited<ReturnType<typeof api.execute>>);
    const out = await runSql('s1', 'SELECT 1', []);
    expect(out.error?.message).toBe(ENGINE_LOST_MESSAGE);
  });

  it('gives up after the timeout and cancels the statement', async () => {
    setStatus('open');
    vi.spyOn(api, 'execute').mockResolvedValue({ executionId: 'x-slow' } as Awaited<ReturnType<typeof api.execute>>);
    const cancel = vi.spyOn(api, 'cancel').mockResolvedValue({ cancelled: true });
    const out = await runSql('s1', 'SELECT 1', [], { timeoutMs: 30 });
    expect(out.status).toBe('error');
    expect(out.error?.code).toBe('TIMEOUT');
    expect(cancel).toHaveBeenCalledWith('s1');
  });

  it('still resolves normally on exec.done and sends skipHistory for internal statements', async () => {
    setStatus('open');
    const exec = vi.spyOn(api, 'execute').mockImplementation(async () => {
      setTimeout(() => engineSocket.dispatch({
        type: 'exec.done', ts: '', executionId: 'x-ok', status: 'ok', elapsedMs: 4, txOpen: false,
      } as Parameters<typeof engineSocket.dispatch>[0]), 0);
      return { executionId: 'x-ok' } as Awaited<ReturnType<typeof api.execute>>;
    });
    const out = await runSql('s1', 'SELECT COUNT(*) FROM t', [], { skipHistory: true });
    expect(out).toMatchObject({ status: 'ok', error: null, elapsedMs: 4 });
    expect(exec.mock.calls[0][1]).toMatchObject({ skipHistory: true });
  });
});
