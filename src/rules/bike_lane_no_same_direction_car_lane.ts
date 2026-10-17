import { z } from "zod";

import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import { evaluateBikeLaneNoSameDirectionCarLane as _eval } from "./segment_analysis";

/** Zod schema for bike_lane_no_same_direction_car_lane rule parameters. */
export const bikeLaneNoSameDirectionCarLaneParamsSchema = z.object({
	max_distance_meters: z.number().optional(),
});

/** Infer params type from schema. */
export type BikeLaneNoSameDirectionCarLaneParamsInput = z.infer<
	typeof bikeLaneNoSameDirectionCarLaneParamsSchema
>;

/**
 * Evaluates the bike_lane_no_same_direction_car_lane rule.
 *
 * Detects route sections on dedicated cycling facilities that lack a
 * nearby same-direction car road.  Reports fail when a confident match
 * places the route on a dedicated cycling facility with no qualifying
 * car road within range serving the route's direction.
 *
 * Uses segment-level analysis: route edges grouped into runs,
 * facility classification, geometric association with companion roads,
 * and local direction comparison.
 *
 * @param definition   — rule definition containing severity, params, and enabled flag
 * @param points       — ordered trackpoints from the GPX file
 * @param context      — rule context providing road matches, OSM ways, and route config
 * @returns array of rule results (per-point failures/uncertainties or summary pass/unknown)
 */
export function evaluateBikeLaneNoSameDirectionCarLane(
	definition: RuleDefinition,
	points: Trackpoint[],
	context: RuleContext,
): RuleResult[] {
	return _eval(definition, points, context);
}
