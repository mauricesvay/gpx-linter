// OSM module — split into cache, fetch, and snapping submodules.
export * from "./osm/cache";
export { fetchOverpassBboxWays } from "./osm/fetch";
export { snapPointsToWays, enrichWithOsm, osmCacheTtlMilliseconds } from "./osm/snapping";
