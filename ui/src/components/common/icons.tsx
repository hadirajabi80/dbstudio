import {
  Columns3, Database, Eye, Folder, KeyRound, Layers, Link2, ListOrdered, Package, Shapes, SquareFunction, Table2, Workflow, Zap,
} from 'lucide-react';
import type { CatalogObjectType, ProviderId } from '../../api/types';

const PROVIDER_STYLE: Record<ProviderId, { label: string; bg: string }> = {
  sqlserver: { label: 'MS', bg: '#c4314b' },
  oracle: { label: 'OR', bg: '#e2570f' },
  sqlite: { label: 'SL', bg: '#3b7dbf' },
};

/** Compact provider glyph; the connection colour (if any) is shown as a ring. */
export function ProviderIcon({ providerId, color, size = 16 }: { providerId: ProviderId | string; color?: string | null; size?: number }) {
  const p = PROVIDER_STYLE[providerId as ProviderId] ?? { label: '?', bg: '#888' };
  return (
    <span
      className="provider-icon"
      style={{ width: size, height: size, background: p.bg, boxShadow: color ? `0 0 0 2px ${color}` : undefined, fontSize: size * 0.5 }}
      aria-hidden="true"
    >
      {p.label}
    </span>
  );
}

const OBJ_ICONS: Record<CatalogObjectType, typeof Table2> = {
  table: Table2,
  view: Eye,
  mview: Layers,
  proc: Workflow,
  func: SquareFunction,
  tablefunc: SquareFunction,
  synonym: Link2,
  sequence: ListOrdered,
  package: Package,
  type: Shapes,
  trigger: Zap,
};

export function ObjectIcon({ type, size = 14 }: { type: CatalogObjectType; size?: number }) {
  const I = OBJ_ICONS[type] ?? Table2;
  return <I size={size} className={`obj-icon obj-${type}`} aria-hidden="true" />;
}

export function ColumnIcon({ pk, size = 14 }: { pk?: boolean; size?: number }) {
  return pk ? <KeyRound size={size} className="obj-icon obj-pk" aria-hidden="true" /> : <Columns3 size={size} className="obj-icon obj-column" aria-hidden="true" />;
}

export function DatabaseIcon({ size = 14 }: { size?: number }) {
  return <Database size={size} className="obj-icon obj-db" aria-hidden="true" />;
}

export function FolderIcon({ size = 14 }: { size?: number }) {
  return <Folder size={size} className="obj-icon obj-folder" aria-hidden="true" />;
}
