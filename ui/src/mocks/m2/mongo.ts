// Mongo mock routes and stream emitters (docs/PLAN-M2.md section 6). Owned by package M2-M; M2-0 committed this empty
// factory, which handlers.ts already calls. Register stream kinds with ctx.streams.register(...) and return the
// MSW handlers of the endpoints (prefix M2_PREFIX); remove the matching entry from PENDING_M2_PREFIXES in
// ../m15/mockRoutes.test.ts once every api.mongo.* call has a route.
import type { RequestHandler } from 'msw';
import type { M2MockContext } from './index';

export function createMongoHandlers(ctx: M2MockContext): RequestHandler[] {
  void ctx;
  return [];
}
