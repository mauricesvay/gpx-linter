/**
 * Public API surface for gpx-route-linter.
 *
 * Export only the stable contract: types, config loading,
 * the linting pipeline, and CLI factory. Internal modules
 * (configSchema, engine metadata, resolver internals, etc.)
 * are intentionally excluded.
 */

// ── CLI ───────────────────────────────────────────────
export { createCli } from "./cli";

// ── Config ────────────────────────────────────────────
export { applyRuleOverride, DEFAULT_CONFIG, loadConfig } from "./config";
// ── Constants ─────────────────────────────────────────
export {
	AMBIGUITY_GAP_METERS,
	BBOX_PADDING_DEGREES,
	CACHE_FILE_NAME,
	CLI_VERSION,
	DEFAULT_MAX_TRACK_POINTS,
	GRID_CELL_DEGREES,
	HIGHWAY_PRIORITY,
	MAX_CHUNK_DEGREES,
	MAX_REQUESTS_PER_SECOND,
	MAX_SNAP_DISTANCE_METERS,
	OSM_CACHE_FILE_NAME,
	OVERPASS_FALLBACK,
	OVERPASS_PRIMARY,
	OVERPASS_TIMEOUT_MS,
	OVERPASS_TTL_MS,
	RATE_LIMIT_BACKOFF_MULTIPLIER,
	RATE_LIMIT_BASE_MS,
	RATE_LIMIT_JITTER_FRACTION,
	RATE_LIMIT_MAX_MS,
	ROAD_CACHE_TTL_MS,
} from "./constants";

// ── Rule registry ──────────────────────────────────────
export {
	getAllRuleMetadata,
	getRuleMetadata,
	type RuleMetadata,
	registerRule,
} from "./engine";
// ── Geo helpers ───────────────────────────────────────
export {
	bearingDegrees,
	distanceMeters,
	isGeoJsonFeatureCollection,
	isWithinFeature,
	pointToGeometryDistanceMeters,
} from "./geo";

// ── GPX parsing ───────────────────────────────────────
export {
	calculateElevationGain,
	calculateMaxGradient,
	parseGpx,
	parseGpxFile,
} from "./gpxParser";
// ── Linting pipeline ──────────────────────────────────
export {
	type FileSystem,
	type LintOptions,
	type LintResult,
	type OsmEnricher,
	type RouteResolver,
	runLinter,
} from "./linter";
// ── Types (stable contracts) ──────────────────────────
export type {
	AvailabilityStatus,
	CacheStats,
	Confidence,
	DataAvailability,
	DataSourceAvailability,
	Finding,
	GeoJsonFeature,
	GeoJsonFeatureCollection,
	GeoJsonGeometry,
	GpxSegment,
	GpxTrack,
	LinterConfig,
	LintPipelineReport,
	LintReport,
	LoopClosureParams,
	MatchCandidate,
	MatchResult,
	// Rule-specific param interfaces
	MaxSlopeParams,
	MissingElevationParams,
	NormalizedTrack,
	OffRoadParams,
	ParsedGpx,
	PipelineContext,
	ResultStatus,
	RoadworksParams,
	RouteGapsParams,
	// Pipeline stage types
	RouteInput,
	RouteMetadata,
	RuleContext,
	RuleDefinition,
	RuleParams,
	RuleResult,
	Severity,
	SharpTurnParams,
	TrackCoordinate,
	Trackpoint,
} from "./types";
