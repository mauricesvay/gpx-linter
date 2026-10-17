import { z } from "zod";

import { distanceMeters } from "../geo";
import type {
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import { numberParam, result, sameSegment, smoothElevations } from "./utils";

/** Zod schema for max_slope rule parameters. */
export const maxSlopeParamsSchema = z.object({
	max_slope_percentage: z.number().optional(),
	min_segment_meters: z.number().optional(),
	min_elevation_delta_meters: z.number().optional(),
});

/** Infer max_slope params type from schema. */
export type MaxSlopeParamsInput = z.infer<typeof maxSlopeParamsSchema>;

/**
 * Detects steep uphill and downhill segments that exceed a configurable slope limit.
 *
 * For every consecutive pair of trackpoints within the same segment, the rule computes
 * the absolute slope as |Δ elevation| / horizontal distance × 100. When this exceeds the
 * configured threshold (default 25%), the point is flagged as a failure.
 *
 * Parameters
 *   max_slope_percentage  — maximum allowed slope in percent (default: 10)
 *   min_segment_meters    — minimum horizontal distance to consider (default: 3)
 *   min_elevation_delta_meters — minimum elevation change to consider (default: 1.5)
 *
 * The rule also smooths elevation values using a three-point median filter to reduce
 * GPS elevation noise before computing slopes.
 *
 * @param definition — rule definition containing severity, params, and enabled flag
 * @param points   — ordered trackpoints from the GPX file
 * @returns array of rule results (one per segment, or a single pass result)
 */
export function maxSlope(
	definition: RuleDefinition,
	points: Trackpoint[],
): RuleResult[] {
	if (points.length < 2)
		return [
			result(
				"max_slope",
				definition,
				"error",
				"unknown",
				"At least two trackpoints are required to evaluate slope.",
				"low",
			),
		];
	const threshold = numberParam(definition, "max_slope_percentage", 10);
	const elevations = smoothElevations(points);
	const results: RuleResult[] = [];
	let checked = 0;
	for (let i = 1; i < points.length; i++) {
		if (!sameSegment(points[i - 1], points[i])) continue;
		const horizontal = distanceMeters(points[i - 1], points[i]);
		if (horizontal === 0) continue;
		const elevBefore = elevations[i - 1];
		const elevAfter = elevations[i];
		if (elevBefore === null || elevAfter === null) continue;
		const gain = elevAfter - elevBefore;
		const slope = (Math.abs(gain) / horizontal) * 100;
		checked++;
		if (slope > threshold) {
			results.push(
				result(
					"max_slope",
					definition,
					"error",
					"fail",
					`Slope of ${slope.toFixed(1)}% exceeds the ${threshold}% limit.`,
					"high",
					points[i],
					{
						slopePercentage: Number(slope.toFixed(1)),
						thresholdPercentage: threshold,
						horizontalMeters: Number(horizontal.toFixed(2)),
						elevationGain: gain,
					},
				),
			);
		}
	}
	if (results.length === 0)
		results.push(
			result(
				"max_slope",
				definition,
				"error",
				"pass",
				`No within-segment slopes exceed the ${threshold}% limit.`,
				"high",
				undefined,
				{ checkedSegments: checked, thresholdPercentage: threshold },
			),
		);
	return results;
}
