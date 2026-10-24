// Explorer icons of Elasticsearch nodes; index and data stream icons carry the health colour (theme tokens).
import { ChartLine, Crown, FileCode, FileSpreadsheet, FolderOpen, Gauge, Link2, ListChecks, Server, SquareTerminal, Table2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TreeRow } from '../Explorer/tree';
import type { IndexMeta, NodeMeta } from './tree';

const HEALTH_COLOR: Record<string, string> = { green: 'var(--success)', yellow: 'var(--warning)', red: 'var(--danger)' };

export function esTreeIcon(row: TreeRow): ReactNode {
  const p = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;
  switch (row.source?.nodeType) {
    case 'overview': return <Gauge {...p} className="obj-icon obj-other" />;
    case 'console': return <SquareTerminal {...p} className="obj-icon obj-routine" />;
    case 'sql': return <FileSpreadsheet {...p} className="obj-icon obj-routine" />;
    case 'tasks': return <ListChecks {...p} className="obj-icon obj-other" />;
    case 'index':
    case 'datastream': {
      const m = row.source.meta as IndexMeta | undefined;
      const Icon = row.source.nodeType === 'index' ? Table2 : ChartLine;
      const color = m?.status === 'close' ? 'var(--fg-muted)' : m?.health ? HEALTH_COLOR[m.health] : undefined;
      return <Icon {...p} className="obj-icon obj-table" style={color ? { color } : undefined} data-health={m?.health ?? undefined} />;
    }
    case 'alias': return <Link2 {...p} className="obj-icon obj-view" />;
    case 'template': return <FileCode {...p} className="obj-icon obj-other" />;
    case 'node': return (row.source.meta as NodeMeta | undefined)?.master ? <Crown {...p} className="obj-icon obj-key" /> : <Server {...p} className="obj-icon obj-other" />;
    default: return <FolderOpen {...p} className="obj-icon obj-folder" />;
  }
}
