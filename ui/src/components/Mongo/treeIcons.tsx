// Explorer icons of Mongo nodes: database, collection (by type), Indexes and Validation children.
import { Clock, Database, Eye, FolderOpen, KeyRound, ListChecks, Table2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TreeRow } from '../Explorer/tree';
import type { CollectionMeta } from './tree';

export function mongoTreeIcon(row: TreeRow): ReactNode {
  const p = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;
  switch (row.source?.nodeType) {
    case 'database': return <Database {...p} className="obj-icon obj-db" />;
    case 'collection': {
      const type = (row.source.meta as CollectionMeta | undefined)?.type;
      if (type === 'view') return <Eye {...p} className="obj-icon obj-view" />;
      if (type === 'timeseries') return <Clock {...p} className="obj-icon obj-table" />;
      return <Table2 {...p} className="obj-icon obj-table" />;
    }
    case 'indexes': return <KeyRound {...p} className="obj-icon obj-pk" />;
    case 'validation': return <ListChecks {...p} className="obj-icon obj-other" />;
    default: return <FolderOpen {...p} className="obj-icon obj-folder" />;
  }
}
