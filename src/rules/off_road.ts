import { z } from "zod";

import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import {
	buildSummaryResult,
	isConfidentMatch,
	numberParam,
	result,
	uncertaintyResult,
} from "./utils";

/** Zod schema for off_road rule parameters. */
export const offRoadParamsSchema = z.object({
	max_distance_meters: z.number().optional(),
});

/** Infer off_road params type from schema. */
export type OffRoadParamsInput = z.infer<typeof offRoadParamsSchema>;

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
	if (context.roadMatching?.status === "unavailable") {
		return [
			result(
				"off_road",
				definition,
				"error",
				"unknown",
				"Road matching is unavailable; distance to road could not be evaluated.",
				"low",
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
				"error",
				"unknown",
				"Road matching did not return a result for every trackpoint.",
				"low",
				undefined,
				{ expectedPoints: points.length, matchedResults: matches.length },
			),
		];
	}

	return evaluateOffRoadPoints(points, matches, definition);
}

function evaluateOffRoadPoints(
	points: Trackpoint[],
	matches: RuleContext["matches"],
	definition: RuleDefinition,
): RuleResult[] {
	const failures: RuleResult[] = [];
	const uncertainties: RuleResult[] = [];
	let evaluated = 0;

	for (let i = 0; i < points.length; i++) {
		const match = matches![i];
		const point = points[i];

		if (!isConfidentMatch(match)) {
			uncertainties.push(
				uncertaintyResult("off_road", definition, point, match),
			);
			continue;
		}

		if (match.distanceToRoad === undefined || !Number.isFinite(match.distanceToRoad)) {
			uncertainties.push(
				result(
					"off_road",
					definition,
					"error",
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
					"off_road",
					definition,
					"error",
					"fail",
					`Trackpoint is ${match.distanceToRoad.toFixed(1)}m from the matched road, beyond the ${threshold}m limit.`,
					match.confidence === "unknown" ? "low" : match.confidence,
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
	}

	return buildSummaryResult(
		"off_road",
		definition,
		failures,
		uncertainties,
		evaluated,
		"All evaluated trackpoints are within the configured road distance.",
	);
}
