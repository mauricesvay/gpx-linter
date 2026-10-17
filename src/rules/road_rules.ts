import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "../types";
import {
	hasBikeContraflow,
	isOneWay,
	isTwoWay,
	numberParam,
	result,
} from "./utils";

/**
 * Evaluates the contraflow_bike rule.
 *
 * Detects routes that travel against the direction of a one-way road
 * without a bicycle contraflow exception.
 *
 * For each matched trackpoint, the rule reads OSM tags (`oneway`,
 * `oneway:bicycle`, `bicycle`, `cycleway`, `cycleway:left`,
 * `cycleway:right`) to determine whether the road permits cycling
 * against the motor-vehicle direction. If the route goes against a
 * one-way road and no contraflow exception exists, the point is
 * flagged as a failure.
 *
 * @param definition   — rule definition containing severity, params, and enabled flag
 * @param points       — ordered trackpoints from the GPX file
 * @param context      — rule context providing road matches, OSM tags, and route config
 * @returns array of rule results (one per trackpoint, or a single pass/unknown result)
 */
export function evaluateContraflowBike(
	definition: RuleDefinition,
	points: Trackpoint[],
	context: RuleContext,
): RuleResult[] {
	const defaultSeverity: Severity = "error";

	if (context.roadMatching?.status === "unavailable") {
		return [
			result(
				"contraflow_bike",
				definition,
				defaultSeverity,
				"unknown",
				"Road matching is unavailable; contraflow could not be evaluated.",
				"low",
				undefined,
				undefined,
				{ source: context.roadMatching.source },
			),
		];
	}

	const matches = context.matches ?? [];
	if (matches.length !== points.length) {
		return [
			result(
				"contraflow_bike",
				definition,
				defaultSeverity,
				"unknown",
				"Road matching did not return a result for every trackpoint.",
				"low",
				undefined,
				{ expectedPoints: points.length, matchedResults: matches.length },
			),
		];
	}

	return evaluateRoadPoints(
		"contraflow_bike",
		definition,
		defaultSeverity,
		points,
		matches,
		context,
	);
}

/**
 * Evaluates the off_road rule.
 *
 * Detects trackpoints that are farther from any matched road
 * than a configurable distance threshold.
 *
 * For each matched trackpoint, the rule reads the `distanceToRoad`
 * field from the road-matching result. When this exceeds the threshold
 * (default 50 m), the point is flagged as off-road.
 *
 * @param definition   — rule definition containing severity, params, and enabled flag
 * @param points       — ordered trackpoints from the GPX file
 * @param context      — rule context providing road matches, OSM tags, and route config
 * @returns array of rule results (one per trackpoint, or a single pass/unknown result)
 */
export function evaluateOffRoad(
	definition: RuleDefinition,
	points: Trackpoint[],
	context: RuleContext,
): RuleResult[] {
	const defaultSeverity: Severity = "error";

	if (context.roadMatching?.status === "unavailable") {
		return [
			result(
				"off_road",
				definition,
				defaultSeverity,
				"unknown",
				"Road matching is unavailable; distance to road could not be evaluated.",
				"low",
				undefined,
				undefined,
				{ source: context.roadMatching.source },
			),
		];
	}

	const matches = context.roadMatches ?? context.matches ?? [];
	if (matches.length !== points.length) {
		return [
			result(
				"off_road",
				definition,
				defaultSeverity,
				"unknown",
				"Road matching did not return a result for every trackpoint.",
				"low",
				undefined,
				{ expectedPoints: points.length, matchedResults: matches.length },
			),
		];
	}

	return evaluateRoadPoints(
		"off_road",
		definition,
		defaultSeverity,
		points,
		matches,
		context,
		true,
	);
}

/**
 * Internal helper for evaluating road-dependent points.
 */
function evaluateRoadPoints(
	ruleId: "contraflow_bike" | "off_road",
	definition: RuleDefinition,
	defaultSeverity: Severity,
	points: Trackpoint[],
	matches: RuleContext["matches"],
	context: RuleContext,
	isOffRoad = false,
): RuleResult[] {
	const failures: RuleResult[] = [];
	const uncertainties: RuleResult[] = [];
	let evaluated = 0;

	for (let i = 0; i < points.length; i++) {
		const match = matches![i];
		const point = points[i];

		if (
			match.status !== "matched" ||
			(match.confidence !== "high" && match.confidence !== "medium")
		) {
			uncertainties.push(
				result(
					ruleId,
					definition,
					defaultSeverity,
					"unknown",
					match.reason ??
						`Road match is ${match.status} with ${match.confidence} confidence.`,
					"low",
					point,
					{
						matchStatus: match.status,
						matchConfidence: match.confidence,
						candidates: match.candidates,
					},
					{ provider: match.provider ?? "unknown" },
				),
			);
			continue;
		}

		if (isOffRoad) {
			if (
				match.distanceToRoad === undefined ||
				!Number.isFinite(match.distanceToRoad)
			) {
				uncertainties.push(
					result(
						ruleId,
						definition,
						defaultSeverity,
						"unknown",
						"Matched road distance is unavailable.",
						"low",
						point,
						undefined,
						{ provider: match.provider, roadId: match.roadId },
					),
				);
				continue;
			}
			evaluated++;
			const threshold = numberParam(definition, "max_distance_meters", 50);
			if (match.distanceToRoad > threshold) {
				failures.push(
					result(
						ruleId,
						definition,
						defaultSeverity,
						"fail",
						`Trackpoint is ${match.distanceToRoad.toFixed(1)}m from the matched road, beyond the ${threshold}m limit.`,
						match.confidence,
						point,
						{
							roadId: match.roadId,
							distanceMeters: match.distanceToRoad,
							thresholdMeters: threshold,
						},
						{ provider: match.provider },
					),
				);
			}
		} else {
			// contraflow_bike logic
			const tags = match.tags;
			if (!tags || tags.oneway === undefined) {
				uncertainties.push(
					result(
						ruleId,
						definition,
						defaultSeverity,
						"unknown",
						"Required OSM oneway/bicycle tags are unavailable for this matched road.",
						"low",
						point,
						undefined,
						{ provider: match.provider, roadId: match.roadId },
					),
				);
				continue;
			}
			if (
				isOneWay(tags.oneway) &&
				(match.direction === undefined || match.direction === "unknown")
			) {
				uncertainties.push(
					result(
						ruleId,
						definition,
						defaultSeverity,
						"unknown",
						"The matched road direction is unavailable, so contraflow cannot be determined.",
						"low",
						point,
						{ roadId: match.roadId, oneway: tags.oneway },
						{ provider: match.provider },
					),
				);
				continue;
			}
			if (!isOneWay(tags.oneway) && !isTwoWay(tags.oneway)) {
				uncertainties.push(
					result(
						ruleId,
						definition,
						defaultSeverity,
						"unknown",
						`OSM uses an unsupported oneway value "${tags.oneway}".`,
						"low",
						point,
						{ roadId: match.roadId, oneway: tags.oneway },
						{ provider: match.provider },
					),
				);
				continue;
			}
			evaluated++;
			const againstDirection =
				tags.oneway === "-1"
					? match.direction === "forward"
					: isOneWay(tags.oneway) && match.direction === "backward";
			const exception = hasBikeContraflow(tags);
			if (againstDirection && !exception) {
				failures.push(
					result(
						ruleId,
						definition,
						defaultSeverity,
						"fail",
						`Route travels against one-way road "${match.roadName ?? match.roadId ?? "unknown"}" without a bicycle contraflow exception.`,
						match.confidence,
						point,
						{
							roadId: match.roadId,
							oneway: tags.oneway,
							direction: match.direction,
							bicycle: tags.bicycle ?? null,
							cycleway: tags.cycleway ?? null,
						},
						{
							provider: match.provider,
							tagSet: ["oneway", "bicycle", "cycleway"],
						},
					),
				);
			}
		}
	}

	const out = [...failures, ...uncertainties];
	if (out.length === 0)
		out.push(
			result(
				ruleId,
				definition,
				defaultSeverity,
				evaluated > 0 ? "pass" : "unknown",
				evaluated > 0
					? isOffRoad
						? "All evaluated trackpoints are within the configured road distance."
						: "No contraflow violations found on evaluated roads."
					: "No sufficiently confident road matches were available.",
				evaluated > 0 ? "high" : "low",
				undefined,
				{ evaluatedPoints: evaluated },
				{ provider: "road-matching" },
			),
		);
	return out;
}
