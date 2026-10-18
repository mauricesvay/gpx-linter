import { z } from "zod";

import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import { evaluateContraflowBike as _eval } from "./segment_analysis";

/** Zod schema for contraflow_bike rule parameters (no params needed). */
export const contraflowBikeParamsSchema = z.object({});

/** Infer contraflow_bike params type from schema. */
export type ContraflowBikeParamsInput = z.infer<
	typeof contraflowBikeParamsSchema
>;

/**
 * Evaluates the contraflow_bike rule.
 *
 * Detects routes that travel against the direction of a one-way road
 * without a bicycle contraflow exception.
 *
 * Uses segment-level analysis: route edges grouped into runs,
 * direction comparison against OSM oneway tags, and bicycle
 * contraflow exception check. Separate cycle tracks on motor roads
 * are excluded from contraflow checks (handled by bike_lane rule).
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
	return _eval(definition, points, context);
}
