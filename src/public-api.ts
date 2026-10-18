/**
 * Public API surface for gpx-route-linter.
 *
 * Export only the stable contract: types, config loading,
 * the linting pipeline, and CLI factory. Internal modules
 * (configSchema, engine metadata, resolver internals, etc.)
 * are intentionally excluded.
 */

// ── Types (stable contracts) ──────────────────────────
export type {
	Severity,
	ResultStatus,
	Confidence,
	AvailabilityStatus,
	Trackpoint,
	GpxSegment,
	GpxTrack,
	RouteMetadata,
	ParsedGpx,
	DataSourceAvailability,
	DataAvailability,
	MatchCandidate,
	MatchResult,
	RuleResult,
	RuleDefinition,
	LinterConfig,
	CacheStats,
	TrackCoordinate,
	LintReport,
	GeoJsonGeometry,
	GeoJsonFeature,
	GeoJsonFeatureCollection,
	// Pipeline stage types
	RouteInput,
	NormalizedTrack,
	PipelineContext,
	RuleContext,
	Finding,
	LintPipelineReport,
	// Rule-specific param interfaces
	MaxSlopeParams,
	SharpTurnParams,
	RoadworksParams,
	OffRoadParams,
	MissingElevationParams,
	RouteGapsParams,
	LoopClosureParams,
	RuleParams,
} from "./types";

// ── Config ────────────────────────────────────────────
export { DEFAULT_CONFIG, loadConfig, applyRuleOverride } from "./config";

// ── Linting pipeline ──────────────────────────────────
export {
	runLinter,
	type RouteResolver,
	type OsmEnricher,
	type FileSystem,
	type LintOptions,
	type LintResult,
} from "./linter";

// ── Rule registry ──────────────────────────────────────
export {
	registerRule,
	getRuleMetadata,
	getAllRuleMetadata,
	type RuleMetadata,
} from "./engine";

// ── CLI ───────────────────────────────────────────────
export { createCli } from "./cli";

// ── GPX parsing ───────────────────────────────────────
export {
	parseGpx,
	parseGpxFile,
	calculateElevationGain,
	calculateMaxGradient,
} from "./gpxParser";

// ── Constants ─────────────────────────────────────────
export {
	CLI_VERSION,
	DEFAULT_MAX_TRACK_POINTS,
	OVERPASS_TTL_MS,
	OVERPASS_TIMEOUT_MS,
	OVERPASS_PRIMARY,
	OVERPASS_FALLBACK,
	MAX_CHUNK_DEGREES,
	BBOX_PADDING_DEGREES,
	GRID_CELL_DEGREES,
	MAX_SNAP_DISTANCE_METERS,
	AMBIGUITY_GAP_METERS,
	HIGHWAY_PRIORITY,
	CACHE_FILE_NAME,
	OSM_CACHE_FILE_NAME,
	ROAD_CACHE_TTL_MS,
	RATE_LIMIT_BASE_MS,
	RATE_LIMIT_MAX_MS,
	RATE_LIMIT_JITTER_FRACTION,
	RATE_LIMIT_BACKOFF_MULTIPLIER,
	MAX_REQUESTS_PER_SECOND,
} from "./constants";

// ── Geo helpers ───────────────────────────────────────
export {
	distanceMeters,
	bearingDegrees,
	pointToGeometryDistanceMeters,
	isWithinFeature,
	isGeoJsonFeatureCollection,
} from "./geo";
