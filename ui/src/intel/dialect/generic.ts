// Batch 3 (plan-batch3 D7): the stand-in spec of a lazily loaded dialect until its chunk has loaded (dialect/registry.ts):
// the SQLite tables (semicolon-ended ANSI-ish SQL, case-insensitive names) under the real dialect id, so dialect-keyed
// code paths still see 'mysql', 'cql'… Costs the initial bundle almost nothing (sqliteSpec is there already).
import type { Dialect } from '../types';
import type { DialectSpec } from './spec';
import { sqliteSpec } from './sqlite';

const cache = new Map<Dialect, DialectSpec>();

/** The generic spec of `id` (cached). */
export function genericSpec(id: Dialect): DialectSpec {
  let s = cache.get(id);
  if (!s) cache.set(id, (s = { ...sqliteSpec, id }));
  return s;
}
