// ClickHouse actions shared by the commands and the views.
import { api, errorMessage } from '../../api/client';
import { toast, useUi } from '../../store/ui';

/** Asks, then runs OPTIMIZE TABLE (optionally one partition, FINAL). Returns true when it ran. */
export async function optimizeTable(cid: string, database: string, table: string, partition?: string | null): Promise<boolean> {
  const r = await useUi.getState().askConfirmAck({
    title: 'Optimize table',
    message: `Run OPTIMIZE TABLE ${database}.${table}${partition ? ` PARTITION ID '${partition}'` : ''}? Merging parts rewrites data on disk and can take a while on large tables.`,
    confirmLabel: 'Optimize',
    ack: { label: 'FINAL: merge down to one part per partition (also when already merged)' },
  });
  if (!r.ok) return false;
  try {
    const res = await api.clickhouse.optimize(cid, { database, table, partition: partition ?? null, final: r.ack });
    toast(res.ok ? 'success' : 'warning', res.message);
    return res.ok;
  } catch (e) {
    toast('error', 'OPTIMIZE failed', errorMessage(e));
    return false;
  }
}

