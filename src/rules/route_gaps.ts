import { z } from "zod";
import { distanceMeters } from "../geo";
import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import { RULE_DEFAULTS } from "./constants";
import { numberParam, result, sameSegment } from "./utils";

/** Zod schema for route_gaps rule parameters. */
export const routeGapsParamsSchema = z.object({
	max_gap_meters: z.number().optional(),
});

/** Infer route_gaps params type from schema. */
export type RouteGapsParamsInput = z.infer<typeof routeGapsParamsSchema>;

/**
 * Identifies large jumps between consecutive trackpoints that indicate
 * a GPS signal loss or a discontinuity in the recorded route.
 *
 * For every consecutive pair of trackpoints within the same segment, the rule
 * computes the geographic distance. When this exceeds a configurable threshold,
 * the point is flagged as a route gap.
 *
 * Parameters
 *   max_gap_meters — maximum allowed distance between consecutive points (default: 500)
 *
 * The rule is skipped entirely when `route_context.ferry_allowed` is true,
 * since ferries intentionally produce large gaps between trackpoints.
 *
 * @param definition — rule definition containing severity, params, and enabled flag
 * @param points   — ordered trackpoints from the GPX file
 * @param context  — rule context providing route configuration (e.g. ferry_allowed)
 * @returns array of rule results (one per gap, or a single pass result)
 */
export function routeGaps(
	definition: RuleDefinition,
	points: Trackpoint[],
	context: RuleContext,
): RuleResult[] {
	if (context.routeContext?.ferry_allowed) {
		return [
			result(
				"route_gaps",
				definition,
				"info",
				"skipped",
				"Route-gap checks are skipped because ferry segments are allowed.",
				"high",
			),
		];
	}
	const threshold = numberParam(
		definition,
		"max_gap_meters",
		(RULE_DEFAULTS.route_gaps as Record<string, unknown>)
			.max_gap_meters as number,
	);
	const results: RuleResult[] = [];
	let checked = 0;
	for (let i = 1; i < points.length; i++) {
		if (!sameSegment(points[i - 1], points[i])) continue;
		checked++;
		const distance = distanceMeters(points[i - 1], points[i]);
		if (distance > threshold) {
			results.push(
				result(
					"route_gaps",
					definition,
					"info",
					"fail",
					`Track jumps ${Math.round(distance)}m, exceeding the ${threshold}m continuity limit.`,
					"high",
					points[i - 1],
					{
						distanceMeters: Math.round(distance),
						thresholdMeters: threshold,
						end: { lat: points[i].lat, lon: points[i].lon },
					},
				),
			);
		}
	}
	if (results.length === 0)
		results.push(
			result(
				"route_gaps",
				definition,
				"info",
				"pass",
				"No within-segment trackpoint gaps exceed the configured threshold.",
				"high",
				undefined,
				{ checkedGaps: checked, thresholdMeters: threshold },
			),
		);
	return results;
}
