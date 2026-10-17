// OSM module — split into cache, fetch, snapping, and enrichment submodules.
export * from "./osm/cache";
export { fetchOverpassBboxWays } from "./osm/fetch";
export { snapPointsToWays, snapSinglePoint, buildWayIndex } from "./osm/snapping";
export type { IndexedWay, ScoredCandidate } from "./osm/snapping";
export { enrichWithOsm, osmCacheTtlMilliseconds } from "./osm/enrichment";
