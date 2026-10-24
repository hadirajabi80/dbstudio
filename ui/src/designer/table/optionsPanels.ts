// Batch 3: provider-specific table options in the table designer (ClickHouse engine, ORDER BY, TTL …). A provider
// registers a lazy panel from its commands.ts; the designer renders it above the column grid and the panel edits
// `TableOptions.extra` (name → text), which the engine's scripter reads.
import type { ComponentType } from 'react';
import type { TableModel } from '../../api/types';

export interface DesignerOptionsPanelProps {
  table: TableModel;
  /** The table already exists (some options cannot change then). */
  existing: boolean;
  /** Read-only (a script is being applied, or the connection is read-only). */
  disabled: boolean;
  onChange(extra: Record<string, string>): void;
}

const PANELS = new Map<string, ComponentType<DesignerOptionsPanelProps>>();

/** Add an options panel for the tables of one provider (returns an unregister function). */
export function registerDesignerOptionsPanel(providerId: string, component: ComponentType<DesignerOptionsPanelProps>): () => void {
  PANELS.set(providerId, component);
  return () => {
    if (PANELS.get(providerId) === component) PANELS.delete(providerId);
  };
}

export function designerOptionsPanel(providerId: string | undefined): ComponentType<DesignerOptionsPanelProps> | undefined {
  return providerId ? PANELS.get(providerId) : undefined;
}
