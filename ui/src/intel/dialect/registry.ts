// Batch 3 (plan-batch3 D7): lazily loaded dialect specs. The four original dialects are static (dialect/index.ts); the
// Batch 3 ones are separate chunks fetched on first use, so they cost the initial bundle nothing. Until a spec is loaded
// getSpec() answers with the generic stand-in (dialect/generic.ts: the SQLite tables under the real id). SqlEditor waits
// for ensureDialect() before it creates its model, and connectAndOpen() starts the load while the console opens.
//
// A WP fills its own dialect/<id>.ts (export `define`, see DialectDefine in spec.ts) and never edits this file.
import type { Dialect } from '../types';
import { buildSpec, phrases, wordSet, words, type DialectKit, type DialectSpec } from './spec';
import { genericSpec } from './generic';

type Loader = () => Promise<DialectSpec>;

/** Runtime helpers a lazy dialect module builds its spec with (it must not import them itself: see spec.ts). */
const KIT: DialectKit = { buildSpec, words, phrases, wordSet };

const LOADERS: Partial<Record<Dialect, Loader>> = {
  mysql: () => import('./mysql').then((m) => m.define(KIT)),
  clickhouse: () => import('./clickhouse').then((m) => m.define(KIT)),
  snowflake: () => import('./snowflake').then((m) => m.define(KIT)),
  cql: () => import('./cql').then((m) => m.define(KIT)),
};

const loaded = new Map<Dialect, DialectSpec>();
const pending = new Map<Dialect, Promise<DialectSpec>>();

/** True for the dialects that load on demand (the Batch 3 ones). */
export function isLazyDialect(d: Dialect): boolean {
  return !!LOADERS[d];
}

/** The loaded spec of a lazy dialect, undefined until ensureDialect() resolved (always undefined for static ones). */
export function loadedSpec(d: Dialect): DialectSpec | undefined {
  return loaded.get(d);
}

/** True when getSpec(d) already answers with the real spec (static dialects, or a lazy one that finished loading). */
export function isDialectReady(d: Dialect): boolean {
  return !LOADERS[d] || loaded.has(d);
}

/**
 * Loads a lazy dialect (once; concurrent calls share the promise). Resolves to the real spec, or to the generic one when
 * the chunk fails to load (offline dev server…), so callers never hang. Static dialects resolve immediately.
 */
export function ensureDialect(d: Dialect): Promise<DialectSpec | null> {
  const load = LOADERS[d];
  if (!load) return Promise.resolve(null);
  const hit = loaded.get(d);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(d);
  if (!p) {
    p = load().then(
      (spec) => {
        loaded.set(d, spec);
        pending.delete(d);
        return spec;
      },
      () => {
        pending.delete(d);
        return genericSpec(d);
      },
    );
    pending.set(d, p);
  }
  return p;
}

export { genericSpec };
