// Ctrl+Alt+P (PLAN-M1.5 A2): always show the parameters dialog, then run through the normal console path
// (`runInTab`), which also handles destructive confirmation, read-only retry and session limits.
import type { RunLabel, SqlBatch } from '../../api/types';
import { runInTab } from '../../app/actions';
import { dialectOf } from '../../store/connections';
import { useTabs } from '../../store/tabs';
import { resolveParams } from './ParamsDialog';

/**
 * Asks for parameters (forced when `force`) and runs with them.
 * Returns false when the batches have no parameters (the caller runs normally), true when handled (ran or cancelled).
 */
export async function runWithParamsIfNeeded(tabId: string, label: RunLabel, batches: SqlBatch[], force = false): Promise<boolean> {
  const tab = useTabs.getState().tabs.find((x) => x.id === tabId);
  if (tab?.kind !== 'console' || !tab.connectionId) return false;
  const params = await resolveParams(tabId, tab.connectionId, dialectOf(tab.connectionId), batches, { force });
  if (params === undefined) return false;
  if (params !== null) await runInTab(tabId, label, batches, { params });
  return true;
}
