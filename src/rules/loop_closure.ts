import { distanceMeters } from "../geo";
import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "../types";
import { numberParam, result } from "./utils";

/**
 * Checks whether a loop route starts and ends at approximately
 * the same geographic location.
 *
 * This rule is only applicable when `route_context.loop_expected` is true.
 * It measures the straight-line distance between the first and last trackpoints
 * of the route. When this exceeds a configurable threshold, the route is flagged
 * as having a closure error (i.e. the rider did not return to the starting point).
 *
 * Parameters
 *   max_return_distance_meters — maximum allowed distance between start and end
 *                                points (default: 100)
 *
 * @param definition — rule definition containing severity, params, and enabled flag
 * @param points   — ordered trackpoints from the GPX file
 * @param context  — rule context providing route configuration (loop_expected)
 * @returns a single rule result with pass/fail/skipped status
 */
export function loopClosure(
	definition: RuleDefinition,
	points: Trackpoint[],
	context: RuleContext,
): RuleResult[] {
	if (!context.routeContext?.loop_expected) {
		return [
			result(
				"loop_closure",
				definition,
				"info",
				"skipped",
				"Loop closure is not applicable because this route is not marked as a loop.",
				"high",
			),
		];
	}
	if (points.length < 2)
		return [
			result(
				"loop_closure",
				definition,
				"info",
				"unknown",
				"At least two trackpoints are required to check loop closure.",
				"low",
			),
		];
	const start = points[0];
	const end = points[points.length - 1];
	const distance = distanceMeters(start, end);
	const threshold = numberParam(definition, "max_return_distance_meters", 100);
	const failed = distance > threshold;
	return [
		result(
			"loop_closure",
			definition,
			"info",
			failed ? "fail" : "pass",
			`Route ends ${Math.round(distance)}m from its start; limit is ${threshold}m.`,
			"high",
			start,
			{
				distanceMeters: Math.round(distance),
				thresholdMeters: threshold,
				end: { lat: end.lat, lon: end.lon },
			},
		),
	];
}
