// Default foreign key constraint names (FK dialog).
import type { Dialect } from '../../api/types';

/** Default constraint name `FK_<table>_<referenced>` (upper case on Oracle, at most 128 characters). */
export function defaultFkName(from: string, to: string, dialect: Dialect): string {
  const raw = `FK_${from}_${to}`.replace(/[^A-Za-z0-9_$#]+/g, '_').slice(0, 128);
  return dialect === 'plsql' ? raw.toUpperCase() : raw;
}
