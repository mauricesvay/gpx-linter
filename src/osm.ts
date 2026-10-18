// OSM module — split into cache, fetch, snapping, and enrichment submodules.
export * from "./osm/cache";
export { enrichWithOsm, osmCacheTtlMilliseconds } from "./osm/enrichment";
export { fetchOverpassBboxWays } from "./osm/fetch";
export type { IndexedWay, ScoredCandidate } from "./osm/snapping";
export {
	buildWayIndex,
	snapPointsToWays,
	snapSinglePoint,
} from "./osm/snapping";
