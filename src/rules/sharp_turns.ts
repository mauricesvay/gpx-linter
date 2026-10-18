import { z } from "zod";

import { bearingDegrees, distanceMeters } from "../geo";
import type { RuleDefinition, RuleResult, Trackpoint } from "../types";
import { numberParam, result, sameSegment } from "./utils";

/** Zod schema for sharp_turns rule parameters. */
export const sharpTurnsParamsSchema = z.object({
	max_angle: z.number().optional(),
	min_segment_meters: z.number().optional(),
	min_heading_change_degrees: z.number().optional(),
});

/** Infer sharp_turns params type from schema. */
export type SharpTurnsParamsInput = z.infer<typeof sharpTurnsParamsSchema>;

/**
 * Detects sharp directional changes (turns) along the route.
 *
 * For every triple of consecutive trackpoints within the same segment, the rule
 * computes the change in heading (bearing) between the incoming and outgoing
 * segments. When this change exceeds a configurable angle threshold, the
 * middle point is flagged as a sharp turn.
 *
 * Parameters
 *   max_angle                    — maximum allowed heading change in degrees (default: 60)
 *   min_segment_meters           — minimum length of each leg to consider (default: 5)
 *   min_heading_change_degrees   — skip turns below this angle (default: 0)
 *
 * Only turns where both legs are at least `min_segment_meters` long are considered,
 * which filters out noise from GPS jitter on short segments.
 *
 * @param definition — rule definition containing severity, params, and enabled flag
 * @param points   — ordered trackpoints from the GPX file
 * @returns array of rule results (one per sharp turn, or a single pass result)
 */
export function sharpTurns(
	definition: RuleDefinition,
	points: Trackpoint[],
): RuleResult[] {
	const limit = numberParam(definition, "max_angle", 60);
	const minLength = numberParam(definition, "min_segment_meters", 5);
	const minimumChange = numberParam(
		definition,
		"min_heading_change_degrees",
		0,
	);
	const results: RuleResult[] = [];
	let considered = 0;
	for (let i = 1; i < points.length - 1; i++) {
		const before = points[i - 1];
		const current = points[i];
		const after = points[i + 1];
		if (!sameSegment(before, current) || !sameSegment(current, after)) continue;
		const firstLength = distanceMeters(before, current);
		const secondLength = distanceMeters(current, after);
		if (firstLength < minLength || secondLength < minLength) continue;
		const incoming = bearingDegrees(before, current);
		const outgoing = bearingDegrees(current, after);
		const rawAngle = Math.abs(outgoing - incoming);
		const change = Math.min(rawAngle, 360 - rawAngle);
		if (change < minimumChange) continue;
		considered++;
		if (change > limit) {
			results.push(
				result(
					"sharp_turn",
					definition,
					"warning",
					"fail",
					`Turn angle ${change.toFixed(1)}° exceeds the ${limit}° limit.`,
					"high",
					current,
					{
						angleDegrees: Number(change.toFixed(1)),
						thresholdDegrees: limit,
						incomingBearing: incoming,
						outgoingBearing: outgoing,
					},
				),
			);
		}
	}
	if (results.length === 0)
		results.push(
			result(
				"sharp_turn",
				definition,
				"warning",
				"pass",
				"No sharp turns exceed the configured threshold.",
				"high",
				undefined,
				{ consideredTurns: considered, thresholdDegrees: limit },
			),
		);
	return results;
}
