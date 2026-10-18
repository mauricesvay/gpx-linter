import {
	evaluateBikeLaneNoSameDirectionCarLane,
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
import { RULE_DEFAULTS } from "./rules/constants";
import type {
	RuleContext,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "./types";
import { errorMessage } from "./utils";

// ── Rule registry types ──────────────────────────────────

/** Metadata describing a registered rule. */
export interface RuleMetadata {
	/** Unique rule identifier (e.g. "max_slope"). */
	id: string;
	/** Human-readable description. */
	description?: string;
	/** Default severity when not overridden by config. */
	defaultSeverity: Severity;
	/** Whether this rule requires road-matching data. */
	requiresRoads: boolean;
	/** Whether this rule is enabled by default. */
	enabledByDefault: boolean;
	/** Custom parameters schema (optional). */
	params?: Record<string, unknown>;
}

// ── Registry state ───────────────────────────────────────

const registry: Record<string, RuleMetadata> = {};

const handlers: Record<
	string,
	(
		def: RuleDefinition,
		pts: Trackpoint[],
		ctx?: RuleContext,
	) => RuleResult[] | Promise<RuleResult[]>
> = {};

// ── Public API ───────────────────────────────────────────

/**
 * Register a rule in the registry.  Called during module
 * initialization to populate built-in rules.  Consumers
 * can also register custom rules at runtime without editing
 * this module.
 *
 * @param id — Unique rule identifier
 * @param metadata — Rule metadata (description, severity, etc.)
 * @param handler — The rule evaluation function
 */
export function registerRule(
	id: string,
	metadata: Omit<RuleMetadata, "id">,
	handler: (
		def: RuleDefinition,
		pts: Trackpoint[],
		ctx?: RuleContext,
	) => RuleResult[] | Promise<RuleResult[]>,
): void {
	registry[id] = { id, ...metadata };
	handlers[id] = handler as (
		def: RuleDefinition,
		pts: Trackpoint[],
		ctx?: RuleContext,
	) => RuleResult[] | Promise<RuleResult[]>;
}

/** Get metadata for a registered rule. */
export function getRuleMetadata(id: string): RuleMetadata | undefined {
	return registry[id];
}

/** Get all registered rule metadata for introspection. */
export function getAllRuleMetadata(): Record<string, RuleMetadata> {
	return { ...registry };
}

// ── Built-in rules ───────────────────────────────────────

registerRule(
	"max_slope",
	{
		defaultSeverity: "error",
		requiresRoads: false,
		enabledByDefault: true,
		description: "Checks for excessive road gradient/slope.",
		params: RULE_DEFAULTS.max_slope,
	},
	(def, pts) => maxSlope(def, pts),
);

registerRule(
	"contraflow_bike",
	{
		defaultSeverity: "error",
		requiresRoads: true,
		enabledByDefault: true,
		description: "Checks for cycling against one-way traffic flow.",
	},
	(def, pts, ctx) => evaluateContraflowBike(def, pts, ctx ?? {}),
);

registerRule(
	"roadworks",
	{
		defaultSeverity: "warning",
		requiresRoads: false,
		enabledByDefault: false,
		description: "Checks for proximity to roadworks/construction zones.",
		params: RULE_DEFAULTS.roadworks,
	},
	(def, pts) => roadworks(def, pts),
);

registerRule(
	"sharp_turn",
	{
		defaultSeverity: "warning",
		requiresRoads: false,
		enabledByDefault: false,
		description: "Checks for sharp turns that may indicate navigation errors.",
		params: RULE_DEFAULTS.sharp_turn,
	},
	(def, pts) => sharpTurns(def, pts),
);

registerRule(
	"off_road",
	{
		defaultSeverity: "error",
		requiresRoads: true,
		enabledByDefault: false,
		description: "Checks for sections of the route that are off-road.",
		params: RULE_DEFAULTS.off_road,
	},
	(def, pts, ctx) => evaluateOffRoad(def, pts, ctx ?? {}),
);

registerRule(
	"missing_elevation",
	{
		defaultSeverity: "info",
		requiresRoads: false,
		enabledByDefault: true,
		description: "Reports trackpoints missing elevation data.",
		params: RULE_DEFAULTS.missing_elevation,
	},
	(def, pts) => missingElevation(def, pts),
);

registerRule(
	"route_gaps",
	{
		defaultSeverity: "info",
		requiresRoads: false,
		enabledByDefault: false,
		description: "Detects large gaps between consecutive trackpoints.",
		params: RULE_DEFAULTS.route_gaps,
	},
	(def, pts, ctx) => routeGaps(def, pts, ctx ?? {}),
);

registerRule(
	"loop_closure",
	{
		defaultSeverity: "info",
		requiresRoads: false,
		enabledByDefault: false,
		description: "Checks whether the route returns near its starting point.",
		params: RULE_DEFAULTS.loop_closure,
	},
	(def, pts, ctx) => loopClosure(def, pts, ctx ?? {}),
);

registerRule(
	"bike_lane_no_same_direction_car_lane",
	{
		defaultSeverity: "warning",
		requiresRoads: true,
		enabledByDefault: false,
		description:
			"Checks for dedicated cycling facilities without a nearby same-direction car road.",
		params: RULE_DEFAULTS.bike_lane_no_same_direction_car_lane,
	},
	(def, pts, ctx) =>
		evaluateBikeLaneNoSameDirectionCarLane(def, pts, ctx ?? {}),
);

// ── Evaluation ───────────────────────────────────────────

/** Compile-time-safe record of all built-in rule IDs → handlers. */
export const BUILTIN_RULES: Record<
	string,
	(
		def: RuleDefinition,
		pts: Trackpoint[],
		ctx?: RuleContext,
	) => RuleResult[] | Promise<RuleResult[]>
> = { ...handlers };

export async function evaluateRules(
	points: Trackpoint[],
	context: RuleContext = {},
): Promise<RuleResult[]> {
	const results: RuleResult[] = [];
	const definitions = { ...context.rules };
	for (const [ruleId, metadata] of Object.entries(registry)) {
		const definition = definitions[ruleId];
		if (!definition) continue;
		if (definition.enabled === false) {
			results.push(
				result(
					ruleId,
					definition,
					metadata.defaultSeverity,
					"skipped",
					"Rule is disabled.",
					"high",
				),
			);
			continue;
		}
		const handler = handlers[ruleId];
		if (!handler) continue;
		try {
			results.push(...(await handler(definition, points, context || {})));
		} catch (err) {
			results.push(
				result(
					ruleId,
					definition,
					metadata.defaultSeverity,
					"unknown",
					`Rule "${ruleId}" failed: ${errorMessage(err)}`,
					"low",
				),
			);
		}
	}
	for (const [ruleId, definition] of Object.entries(definitions)) {
		if (!(ruleId in registry)) {
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
