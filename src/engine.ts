import {
	bearingDegrees,
	distanceMeters,
	isGeoJsonFeatureCollection,
	isWithinFeature,
} from "./geo";
import {
	evaluateContraflowBike,
	evaluateOffRoad,
	loopClosure,
	maxSlope,
	missingElevation,
	result,
	roadworks,
	routeGaps,
	sharpTurns,
} from "./rules";
import type {
	Confidence,
	GeoJsonFeatureCollection,
	MatchResult,
	RuleContext,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "./types";

const RULES: Record<string, { severity: Severity; requiresRoads?: boolean }> = {
	max_slope: { severity: "error" },
	contraflow_bike: { severity: "error", requiresRoads: true },
	roadworks: { severity: "warning" },
	sharp_turn: { severity: "warning" },
	off_road: { severity: "error", requiresRoads: true },
	missing_elevation: { severity: "info" },
	route_gaps: { severity: "info" },
	loop_closure: { severity: "info" },
};

export function evaluateRules(
	points: Trackpoint[],
	context: RuleContext = {},
): RuleResult[] {
	const results: RuleResult[] = [];
	const definitions = { ...context.rules };
	for (const [ruleId, metadata] of Object.entries(RULES)) {
		const definition = definitions[ruleId];
		if (!definition) continue;
		if (definition.enabled === false) {
			results.push(
				result(
					ruleId,
					definition,
					metadata.severity,
					"skipped",
					"Rule is disabled.",
					"high",
				),
			);
			continue;
		}
		if (metadata.requiresRoads) {
			if (ruleId === "contraflow_bike") {
				results.push(...evaluateContraflowBike(definition, points, context));
			} else {
				results.push(...evaluateOffRoad(definition, points, context));
			}
			continue;
		}
		switch (ruleId) {
			case "max_slope":
				results.push(...maxSlope(definition, points));
				break;
			case "roadworks":
				results.push(...roadworks(definition, points));
				break;
			case "sharp_turn":
				results.push(...sharpTurns(definition, points));
				break;
			case "missing_elevation":
				results.push(...missingElevation(definition, points));
				break;
			case "route_gaps":
				results.push(...routeGaps(definition, points, context));
				break;
			case "loop_closure":
				results.push(...loopClosure(definition, points, context));
				break;
		}
	}
	for (const [ruleId, definition] of Object.entries(definitions)) {
		if (!(ruleId in RULES)) {
			if (definition.enabled === false) {
				results.push(
					result(
						ruleId,
						definition,
						definition.severity ?? "info",
						"skipped",
						"Rule is disabled.",
						"high",
					),
				);
			} else {
				results.push(
					result(
						ruleId,
						definition,
						definition.severity ?? "warning",
						"unknown",
						`Unsupported rule template "${ruleId}".`,
						"low",
					),
				);
			}
		}
	}
	return results;
}
