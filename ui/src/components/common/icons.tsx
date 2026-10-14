import {
  Columns3, Database, Eye, File, Folder, FunctionSquare, Hash, Key, Layers, Link, Link2, Package, Server, Shapes,
  SquareFunction, Table2, Zap,
} from 'lucide-react';
import type { CatalogObjectType, ProviderId } from '../../api/types';
import { connColorCss } from '../../theme/connColors';

// Iconography (docs/PLAN-M1.5.md section 3): lucide only, 16 px, stroke 1.5, currentColor; fixed object-type icons.

const PROVIDER_ICON: Record<ProviderId, { Icon: typeof Server; label: string }> = {
  sqlserver: { Icon: Server, label: 'SQL Server' },
  oracle: { Icon: Database, label: 'Oracle' },
  sqlite: { Icon: File, label: 'SQLite' },
};

export const PROVIDER_LABEL: Record<string, string> = { sqlserver: 'SQL Server', oracle: 'Oracle', sqlite: 'SQLite' };

/** Provider glyph (Server / Database / File) on a provider-tinted tile; the connection colour is shown as a ring. */
export function ProviderIcon({ providerId, color, size = 16 }: { providerId: ProviderId | string; color?: string | null; size?: number }) {
  const p = PROVIDER_ICON[providerId as ProviderId] ?? { Icon: Database, label: providerId };
  const ring = connColorCss(color);
  return (
    <span
      className={`provider-icon provider-${providerId}`}
      style={{ width: size, height: size, boxShadow: ring ? `0 0 0 2px var(--bg-panel), 0 0 0 3.5px ${ring}` : undefined }}
      aria-hidden="true"
    >
      <p.Icon size={Math.round(size * 0.68)} strokeWidth={2} />
    </span>
  );
}

const OBJ_ICONS: Record<CatalogObjectType, typeof Table2> = {
  table: Table2,
  view: Eye,
  mview: Layers,
  proc: SquareFunction,
  func: FunctionSquare,
  tablefunc: FunctionSquare,
  synonym: Link2,
  sequence: Hash,
  package: Package,
  type: Shapes,
  trigger: Zap,
};

export function ObjectIcon({ type, size = 16 }: { type: CatalogObjectType; size?: number }) {
  const I = OBJ_ICONS[type] ?? Table2;
  return <I size={size} strokeWidth={1.5} className={`obj-icon obj-${type}`} aria-hidden="true" />;
}

/** Column icon; primary keys get a Key badge, foreign keys a Link badge. */
export function ColumnIcon({ pk, fk, size = 16 }: { pk?: boolean; fk?: boolean; size?: number }) {
  return (
    <span className="col-icon" aria-hidden="true">
      <Columns3 size={size} strokeWidth={1.5} className="obj-icon obj-column" />
      {pk ? <Key size={9} strokeWidth={2.5} className="col-badge obj-pk" /> : fk ? <Link size={9} strokeWidth={2.5} className="col-badge obj-fk" /> : null}
    </span>
  );
}

export function DatabaseIcon({ size = 16 }: { size?: number }) {
  return <Database size={size} strokeWidth={1.5} className="obj-icon obj-db" aria-hidden="true" />;
}

export function FolderIcon({ size = 16 }: { size?: number }) {
  return <Folder size={size} strokeWidth={1.5} className="obj-icon obj-folder" aria-hidden="true" />;
}
