import type { RouteId } from "@corridoros/domain";
import { CorrespondentRoute } from "./correspondent/index.js";
import type { Route } from "./route.js";
import { TokenizedRoute } from "./tokenized/index.js";

/** Route registry — adding a route means implementing Route and registering it here (CLAUDE.md §17.2). */
export function createRouteRegistry(): Record<RouteId, Route> {
  return {
    CORRESPONDENT: new CorrespondentRoute(),
    TOKENIZED: new TokenizedRoute(),
  };
}
