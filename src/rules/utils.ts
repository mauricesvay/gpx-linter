import { isGeoJsonFeatureCollection } from "../geo";
import type {
	Confidence,
	GeoJsonFeatureCollection,
	MatchResult,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "../types";

/**
 * Shared helpers used by all rule implementations.
 *
 * ──────────────────────────────────────────────────────────────────────
 * result() — Constructs a RuleResult object.
 *
 *   Every rule function produces one or more RuleResult objects via this
 *   helper. It assembles the rule ID, status, severity, confidence, message,
 *   and optional evidence / source metadata into the standard result shape.
 *
 * ──────────────────────────────────────────────────────────────────────
 * numberParam() — Reads a numeric parameter from a rule definition with a fallback.
 *
 *   Used by all rules to read their configurable parameters (e.g. max_angle,
 *   max_slope_percentage, buffer_meters) from the rule definition, falling
 *   back to the provided default when the parameter is missing or invalid.
 *
 * ──────────────────────────────────────────────────────────────────────
 * sameSegment() — Checks whether two trackpoints belong to the same GPX segment.
 *
 *   GPX files can contain multiple <trkseg> elements within a track. Points
 *   from different segments are not consecutive for rule purposes.
 *
 * ──────────────────────────────────────────────────────────────────────
 * hasBikeContraflow() — Determines whether an OSM road permits cycling
 *                       against the motor-vehicle direction.
 *
 *   Reads OSM tags (`oneway:bicycle`, `bicycle`, `cycleway`,
 *   `cycleway:left`, `cycleway:right`) to detect contraflow exceptions.
 *   Returns true when the road allows cycling against traffic (e.g.
 *   `oneway:bicycle=no`, `bicycle=designated`, or a contraflow cycleway).
 *
 * ──────────────────────────────────────────────────────────────────────
 * isOneWay() / isTwoWay() — Classify an OSM `oneway` tag value.
 *
 *   `isOneWay` returns true for values meaning traffic flows in one direction
 *   (`yes`, `1`, `true`, `-1`). `isTwoWay` returns true for values meaning
 *   traffic flows in both directions (`no`, `0`, `false`).
 *
 * ──────────────────────────────────────────────────────────────────────
 * smoothElevations() — Applies a three-point median filter to elevation data.
 *
 *   Replaces each point's elevation with the median of itself and its
 *   neighbours (within the same segment). This reduces GPS elevation noise
 *   that would otherwise produce spuriously high slope readings.
 *
 * ──────────────────────────────────────────────────────────────────────
 * isFeatureCollection() — Type guard for GeoJSON FeatureCollections.
 *
 *   Validates that a value conforms to the GeoJSON FeatureCollection
 *   schema used by the roadworks rule.
 *
 * ──────────────────────────────────────────────────────────────────────
 * isConfidentMatch() — Checks whether a road match is usable by rules.
 *
 *   A match is "confident" when its status is `matched` and its
 *   confidence is `high` or `medium`. Used by the road-dependent rules
 *   (contraflow_bike, off_road) to decide when a point can be evaluated.
 *
 * ──────────────────────────────────────────────────────────────────────
 * uncertaintyResult() — Builds an `unknown` result for a non-confident match.
 *
 *   When a road match is not confident, rules emit this result so the
 *   point is reported as unevaluated rather than silently passed.
 *
 * ──────────────────────────────────────────────────────────────────────
 * buildSummaryResult() — Assembles per-point results plus a pass summary.
 *
 *   If a rule produced no failures or uncertainties, appends a single
 *   `pass` (or `unknown` when nothing was evaluated) result so every
 *   rule always reports at least one outcome.
 */

export function result(
	ruleId: string,
	definition: RuleDefinition,
	defaultSeverity: Severity,
	status: RuleResult["status"],
	message: string,
	confidence: Confidence,
	point?: Trackpoint,
	evidence?: Record<string, unknown>,
	source?: Record<string, unknown>,
): RuleResult {
	const value: RuleResult = {
		ruleId,
		status,
		severity: definition.severity ?? defaultSeverity,
		confidence,
		message,
	};
	if (point) {
		value.lat = point.lat;
		value.lon = point.lon;
	}
	if (evidence) value.evidence = evidence;
	if (source) value.source = source;
	return value;
}

export function numberParam(
	definition: RuleDefinition,
	name: string,
	fallback: number,
): number {
	const value = definition.params?.[name];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function sameSegment(a: Trackpoint, b: Trackpoint): boolean {
	return a.segmentId === b.segmentId;
}

export function hasBikeContraflow(tags: Record<string, string>): boolean {
	if (
		tags["oneway:bicycle"] === "no" ||
		["yes", "designated", "opposite"].includes(
			tags.bicycle?.toLowerCase() ?? "",
		)
	)
		return true;
	return [tags.cycleway, tags["cycleway:left"], tags["cycleway:right"]].some(
		(value) =>
			value !== undefined &&
			["opposite", "opposite_lane", "opposite_track"].includes(
				value.toLowerCase(),
			),
	);
}

export function isOneWay(value: string | undefined): boolean {
	return (
		value !== undefined &&
		["yes", "1", "true", "-1"].includes(value.toLowerCase())
	);
}

export function isTwoWay(value: string | undefined): boolean {
	return (
		value !== undefined && ["no", "0", "false"].includes(value.toLowerCase())
	);
}

export function isFeatureCollection(
	value: unknown,
): value is GeoJsonFeatureCollection {
	return isGeoJsonFeatureCollection(value);
}

export function isConfidentMatch(match: MatchResult): boolean {
	return (
		match.status === "matched" &&
		(match.confidence === "high" || match.confidence === "medium")
	);
}

export function uncertaintyResult(
	ruleId: string,
	definition: RuleDefinition,
	point: Trackpoint,
	match: MatchResult,
): RuleResult {
	const confidence = match.confidence === "unknown" ? "low" : match.confidence;
	return result(
		ruleId,
		definition,
		"error",
		"unknown",
		match.reason ??
			`Road match is ${match.status} with ${match.confidence} confidence.`,
		confidence,
		point,
		{
			matchStatus: match.status,
			matchConfidence: match.confidence,
			candidates: match.candidates,
		},
		{ provider: match.provider ?? "unknown" },
	);
}

export function buildSummaryResult(
	ruleId: string,
	definition: RuleDefinition,
	failures: RuleResult[],
	uncertainties: RuleResult[],
	evaluated: number,
	passMessage: string,
): RuleResult[] {
	const out = [...failures, ...uncertainties];
	if (out.length === 0)
		out.push(
			result(
				ruleId,
				definition,
				"error",
				evaluated > 0 ? "pass" : "unknown",
				evaluated > 0
					? passMessage
					: "No sufficiently confident road matches were available.",
				evaluated > 0 ? "high" : "low",
				undefined,
				{ evaluatedPoints: evaluated },
				{ provider: "road-matching" },
			),
		);
	return out;
}

export function smoothElevations(points: Trackpoint[]): (number | null)[] {
	return points.map((point, index) => {
		if (point.ele === null) return null;
		const previous = points[index - 1];
		const next = points[index + 1];
		const beforeElevation =
			previous?.segmentId === point.segmentId
				? (previous.ele ?? point.ele)
				: point.ele;
		const afterElevation =
			next?.segmentId === point.segmentId ? (next.ele ?? point.ele) : point.ele;
		const window = [beforeElevation, point.ele, afterElevation].sort(
			(a, b) => a - b,
		);
		return window[1];
	});
}
