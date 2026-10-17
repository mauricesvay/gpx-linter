import { z } from "zod";

import type {
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import { numberParam, result } from "./utils";

/** Zod schema for missing_elevation rule parameters. */
export const missingElevationParamsSchema = z.object({
	max_missing_elevation_percentage: z.number().optional(),
});

/** Infer missing_elevation params type from schema. */
export type MissingElevationParamsInput = z.infer<typeof missingElevationParamsSchema>;

/**
 * Reports the percentage of trackpoints that lack elevation data.
 *
 * This rule is informational. It counts how many trackpoints have no elevation
 * (`ele` is null) and compares the percentage against a configurable threshold.
 * It does not flag individual points; it produces a single summary result.
 *
 * Parameters
 *   max_missing_elevation_percentage — maximum allowed percentage of missing
 *                                      elevation data (default: 50)
 *
 * This is useful for assessing whether the GPX file has sufficient elevation
 * data to support rules that depend on it (e.g. `max_slope`).
 *
 * @param definition — rule definition containing severity, params, and enabled flag
 * @param points   — ordered trackpoints from the GPX file
 * @returns a single rule result with pass/fail status and counts
 */
export function missingElevation(
	definition: RuleDefinition,
	points: Trackpoint[],
): RuleResult[] {
	const threshold = numberParam(
		definition,
		"max_missing_elevation_percentage",
		50,
	);
	const total = points.length;
	if (total === 0)
		return [
			result(
				"missing_elevation",
				definition,
				"info",
				"skipped",
				"No trackpoints to evaluate.",
				"high",
			),
		];
	const missing = points.filter((p) => p.ele === null).length;
	const percentage = (missing / total) * 100;
	const failed = percentage > threshold;
	return [
		result(
			"missing_elevation",
			definition,
			"info",
			failed ? "fail" : "pass",
			`${missing} of ${total} trackpoints (${percentage.toFixed(1)}%) are missing elevation data; limit is ${threshold}%.`,
			"high",
			undefined,
			{
				missingCount: missing,
				totalCount: total,
				missingPercentage: Number(percentage.toFixed(1)),
				thresholdPercentage: threshold,
			},
		),
	];
}
