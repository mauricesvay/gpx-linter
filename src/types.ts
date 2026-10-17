export type Severity = "error" | "warning" | "info";
export type ResultStatus = "pass" | "fail" | "unknown" | "skipped";
export type Confidence = "high" | "medium" | "low";
export type AvailabilityStatus =
	| "not_required"
	| "complete"
	| "partial"
	| "unavailable";

export interface Trackpoint {
	lat: number;
	lon: number;
	ele: number | null;
	time: Date | null;
	distanceFromStart: number;
	bearing: number | null;
	index: number;
	segmentId: number;
	distanceTo(other: Trackpoint): number;
}

export interface GpxSegment {
	points: Trackpoint[];
}

export interface GpxTrack {
	name: string | null;
	segments: GpxSegment[];
}

export interface RouteMetadata {
	gpxName: string | null;
	gpxCreator: string | null;
	trackDate: Date | null;
	totalPoints: number;
	totalDistance: number;
	totalElevationGain: number;
}

export interface ParsedGpx {
	tracks: GpxTrack[];
	points: Trackpoint[];
	metadata: RouteMetadata;
}

export interface DataSourceAvailability {
	status: AvailabilityStatus;
	source: string;
	requestedItems: number;
	availableItems: number;
	message?: string;
}

export interface DataAvailability {
	gpx: DataSourceAvailability;
	roadMatching: DataSourceAvailability;
	osm: DataSourceAvailability;
	roadworks: DataSourceAvailability;
	incomplete: boolean;
}

export interface MatchCandidate {
	roadId: string;
	score: number;
	highway?: string;
	distanceToRoad?: number;
}

export interface MatchResult {
	status: "matched" | "ambiguous" | "unmatched";
	confidence: "high" | "medium" | "low" | "unknown";
	score: number;
	roadId?: string;
	roadName?: string;
	distanceToRoad?: number;
	osmDistanceToRoad?: number;
	reason?: string;
	candidates?: MatchCandidate[];
	provider?: string;
	tags?: Record<string, string>;
	direction?: "forward" | "backward" | "unknown";
}

export interface RuleResult {
	ruleId: string;
	status: ResultStatus;
	severity: Severity;
	confidence: Confidence;
	message: string;
	lat?: number;
	lon?: number;
	evidence?: Record<string, unknown>;
	source?: Record<string, unknown>;
}

export interface RuleDefinition {
	enabled?: boolean;
	severity?: Severity;
	description?: string;
	params?: Record<string, unknown>;
	data?: unknown;
}

// Typed parameter interfaces for each rule
export interface MaxSlopeParams {
	max_slope_percentage?: number;
	min_segment_meters?: number;
	min_elevation_delta_meters?: number;
}

export interface SharpTurnParams {
	max_angle?: number;
	min_segment_meters?: number;
	min_heading_change_degrees?: number;
}

export interface RoadworksParams {
	buffer_meters?: number;
	geojson_file?: string;
}

export interface OffRoadParams {
	max_distance_meters?: number;
}

export interface MissingElevationParams {
	max_missing_elevation_percentage?: number;
}

export interface RouteGapsParams {
	max_gap_meters?: number;
}

export interface LoopClosureParams {
	max_return_distance_meters?: number;
}

// Union of all rule parameter types
export type RuleParams =
	| MaxSlopeParams
	| SharpTurnParams
	| RoadworksParams
	| OffRoadParams
	| MissingElevationParams
	| RouteGapsParams
	| LoopClosureParams;

export interface LinterConfig {
	rules: Record<string, RuleDefinition>;
	routing?: {
		provider?: "osrm" | "graphhopper" | "offline";
		fallback?: "osrm" | "graphhopper";
		url?: string;
		graphhopper_url?: string;
		osrm_url?: string;
		batch_size?: number;
		overpass_url?: string;
		cache?: boolean;
		cache_dir?: string;
	};
	reporting?: {
		format?: "text" | "json" | "html";
		color?: "auto" | "always" | "never";
	};
	route_context?: {
		route_type?: string;
		loop_expected?: boolean;
		terrain?: string;
		bike_type?: string;
		expected_access?: string;
		ferry_allowed?: boolean;
		ignore_dead_end?: boolean;
	};
}

export interface RuleContext {
	rules?: Record<string, RuleDefinition>;
	roadMatching?: DataSourceAvailability;
	matches?: MatchResult[];
	roadMatches?: MatchResult[];
	routeContext?: LinterConfig["route_context"];
}

export interface CacheStats {
	hits: number;
	misses: number;
}

export interface TrackCoordinate {
	lat: number;
	lon: number;
}

export interface LintReport {
	routeName: string;
	generatedAt: string;
	summary: {
		severity: Record<Severity, number>;
		status: Record<ResultStatus, number>;
	};
	rules: Record<string, { failures: number; unknown: number; skipped: number }>;
	results: RuleResult[];
	availability: DataAvailability;
	cache: CacheStats;
	exitCode: 0 | 1 | 2 | 3;
	trackCoords?: TrackCoordinate[];
}

export type GeoJsonGeometry =
	| { type: "Point"; coordinates: [number, number] }
	| { type: "MultiPoint"; coordinates: [number, number][] }
	| { type: "LineString"; coordinates: [number, number][] }
	| { type: "MultiLineString"; coordinates: [number, number][][] }
	| { type: "Polygon"; coordinates: [number, number][][] }
	| { type: "MultiPolygon"; coordinates: [number, number][][][] };

export interface GeoJsonFeature {
	type: "Feature";
	geometry: GeoJsonGeometry | null;
	properties?: Record<string, unknown> | null;
}

export interface GeoJsonFeatureCollection {
	type: "FeatureCollection";
	features: GeoJsonFeature[];
}
