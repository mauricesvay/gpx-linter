import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Trackpoint,
} from "../types";
import {
	buildSummaryResult,
	hasBikeContraflow,
	isConfidentMatch,
	isOneWay,
	isTwoWay,
	result,
	uncertaintyResult,
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
	if (context.roadMatching?.status === "unavailable") {
		return [
			result(
				"contraflow_bike",
				definition,
				"error",
				"unknown",
				"Road matching is unavailable; contraflow could not be evaluated.",
				"low",
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
				"error",
				"unknown",
				"Road matching did not return a result for every trackpoint.",
				"low",
				undefined,
				{ expectedPoints: points.length, matchedResults: matches.length },
			),
		];
	}

	return evaluateContraflowPoints(points, matches, definition);
}

function evaluateContraflowPoints(
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
				uncertaintyResult("contraflow_bike", definition, point, match),
			);
			continue;
		}

		const tags = match.tags;
		if (!tags || tags.oneway === undefined) {
			uncertainties.push(
				result(
					"contraflow_bike",
					definition,
					"error",
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
					"contraflow_bike",
					definition,
					"error",
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
					"contraflow_bike",
					definition,
					"error",
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
			const confidence = match.confidence === "unknown" ? "low" : match.confidence;
			failures.push(
				result(
					"contraflow_bike",
					definition,
					"error",
					"fail",
					`Route travels against one-way road "${match.roadName ?? match.roadId ?? "unknown"}" without a bicycle contraflow exception.`,
					confidence,
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

	return buildSummaryResult(
		"contraflow_bike",
		definition,
		failures,
		uncertainties,
		evaluated,
		"No contraflow violations found on evaluated roads.",
	);
}
