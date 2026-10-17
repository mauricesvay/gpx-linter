/**
 * Centralized constants for the GPX linter.
 *
 * All runtime defaults, thresholds, and configuration values
 * are defined here so that changing one constant does not
 * require cross-file code review.
 */

// ── GPX parsing limits ──────────────────────────────────
export const DEFAULT_MAX_TRACK_POINTS = 50_000;

// ── Overpass / OSM constants ────────────────────────────
export const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
export const OVERPASS_FALLBACK = "https://overpass.kumi.systems/api/interpreter";
export const OVERPASS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const OVERPASS_TIMEOUT_MS = 25_000;

// ── Routing / snapping constants ─────────────────────────
export const MAX_CHUNK_DEGREES = 0.2;
export const BBOX_PADDING_DEGREES = 0.005;
export const GRID_CELL_DEGREES = 0.02;
export const MAX_SNAP_DISTANCE_METERS = 100;
export const AMBIGUITY_GAP_METERS = 15;

// ── Highway classification priority ──────────────────────
export const HIGHWAY_PRIORITY: Record<string, number> = {
	motorway: 7,
	trunk: 6,
	primary: 5,
	secondary: 4,
	tertiary: 3,
	residential: 2,
	unclassified: 2,
	service: 1,
	pedestrian: 1,
};

// ── Cache constants ──────────────────────────────────────
export const DEFAULT_CACHE_DIR =
	typeof process !== "undefined"
		? (() => {
				const os = require("node:os");
				return require("node:path").join(os.homedir(), ".cache", "gpxlint");
		  })()
		: "/tmp/gpxlint";
export const OSM_CACHE_FILE_NAME = "osm-cache.json";
export const CACHE_FILE_NAME = "cache.json";
export const ROAD_CACHE_TTL_MS = 30 * 24 * 60 * 1000; // 30 days

// ── Rate-limit / backoff constants ───────────────────────
export const RATE_LIMIT_BASE_MS = 1000;
export const RATE_LIMIT_MAX_MS = 30_000;
export const RATE_LIMIT_JITTER_FRACTION = 0.25;
export const RATE_LIMIT_BACKOFF_MULTIPLIER = 2;
export const MAX_REQUESTS_PER_SECOND = 1;

// ── CLI constants ────────────────────────────────────────
export const CLI_VERSION = "1.0.0";
