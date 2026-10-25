import { readFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { z } from "zod";
import {
	linterConfigSchema,
	type reportingConfigSchema,
	type routeContextSchema,
	type routingConfigSchema,
} from "./configSchema";
import { RULE_DEFAULTS } from "./rules/constants";
import type { LinterConfig, RuleDefinition, Severity } from "./types";
import { errorMessage, isRecord } from "./utils";

/**
 * Deep-freeze an object so that nested objects are also frozen.
 * Prevents accidental mutation of DEFAULT_CONFIG across calls.
 */
function deepFreeze<T>(obj: T): T {
	if (obj === null || typeof obj !== "object") return obj;
	Object.freeze(obj);
	for (const key of Object.keys(obj)) {
		const value = (obj as Record<string, unknown>)[key];
		if (
			value !== null &&
			typeof value === "object" &&
			!Object.isFrozen(value)
		) {
			deepFreeze(value);
		}
	}
	return obj;
}

const _DEFAULT_CONFIG: LinterConfig = {
	rules: {
		max_slope: {
			enabled: true,
			severity: "error",
			params: { ...(RULE_DEFAULTS.max_slope as Record<string, unknown>) },
		},
		contraflow_bike: { enabled: true, severity: "error" },
		roadworks: {
			enabled: false,
			severity: "warning",
			params: { ...(RULE_DEFAULTS.roadworks as Record<string, unknown>) },
		},
		sharp_turn: {
			enabled: false,
			severity: "warning",
			params: { ...(RULE_DEFAULTS.sharp_turn as Record<string, unknown>) },
		},
		off_road: {
			enabled: false,
			severity: "error",
			params: { ...(RULE_DEFAULTS.off_road as Record<string, unknown>) },
		},
		missing_elevation: {
			enabled: true,
			severity: "info",
			params: {
				...(RULE_DEFAULTS.missing_elevation as Record<string, unknown>),
			},
		},
		route_gaps: {
			enabled: false,
			severity: "info",
			params: { ...(RULE_DEFAULTS.route_gaps as Record<string, unknown>) },
		},
		loop_closure: {
			enabled: false,
			severity: "info",
			params: { ...(RULE_DEFAULTS.loop_closure as Record<string, unknown>) },
		},
		bike_lane_no_same_direction_car_lane: {
			enabled: true,
			severity: "warning",
			params: {
				...(RULE_DEFAULTS.bike_lane_no_same_direction_car_lane as Record<
					string,
					unknown
				>),
			},
		},
	},
	routing: {
		provider: "overpass",
		cache: true,
	},
	reporting: { format: "text", color: "auto" },
	route_context: { loop_expected: false, ferry_allowed: false },
};
export const DEFAULT_CONFIG: LinterConfig = deepFreeze(_DEFAULT_CONFIG);

export async function loadConfig(configPath: string): Promise<LinterConfig> {
	if (!configPath) return structuredClone(DEFAULT_CONFIG);
	let contents: string;
	try {
		contents = await readFile(configPath, "utf8");
	} catch (error) {
		throw new Error(
			`Unable to read config file "${configPath}": ${errorMessage(error)}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(contents);
	} catch (error) {
		throw new Error(
			`Invalid YAML in config file "${configPath}": ${errorMessage(error)}`,
		);
	}
	if (!isRecord(parsed))
		throw new Error("Configuration must be a YAML mapping");

	// Validate the raw parsed config against the zod schema
	const validation = linterConfigSchema.safeParse(parsed);
	if (!validation.success) {
		const firstError = validation.error.issues[0];
		const message = firstError?.message ?? "Configuration validation failed";
		throw new Error(message);
	}

	const config = structuredClone(DEFAULT_CONFIG);
	const validated = validation.data;

	// Merge rules
	if (validated.rules !== undefined) {
		for (const [id, rawDefinition] of Object.entries(validated.rules)) {
			if (!isRecord(rawDefinition))
				throw new Error(`Rule "${id}" must be a mapping`);
			const definition: RuleDefinition = {
				enabled:
					typeof rawDefinition.enabled === "boolean"
						? rawDefinition.enabled
						: undefined,
				severity: isSeverity(rawDefinition.severity)
					? rawDefinition.severity
					: undefined,
				description:
					typeof rawDefinition.description === "string"
						? rawDefinition.description
						: undefined,
				params: recordOrEmpty(rawDefinition.params),
				data: rawDefinition.data,
			};
			const base = config.rules[id] ?? { enabled: true };
			config.rules[id] = {
				...base,
				...definition,
				params: { ...base.params, ...recordOrEmpty(definition.params) },
			};
			if (typeof definition.params?.geojson_file === "string") {
				config.rules[id].params = {
					...config.rules[id].params,
					geojson_file: path.resolve(
						path.dirname(configPath),
						definition.params.geojson_file,
					),
				};
			}
		}
	}

	// Merge routing
	if (validated.routing !== undefined) {
		config.routing = mergeRouting(
			config.routing,
			validated.routing,
			configPath,
		);
	}

	// Merge reporting
	if (validated.reporting !== undefined) {
		config.reporting = mergeReporting(config.reporting, validated.reporting);
	}

	// Merge route context
	if (validated.route_context !== undefined) {
		config.route_context = mergeRouteContext(
			config.route_context,
			validated.route_context,
		);
	}

	return config;
}

export function applyRuleOverride(
	config: LinterConfig,
	ruleId: string,
	enabled: boolean,
): LinterConfig {
	if (!config.rules[ruleId]) throw new Error(`Unknown rule "${ruleId}"`);
	return {
		...config,
		rules: { ...config.rules, [ruleId]: { ...config.rules[ruleId], enabled } },
	};
}

function isSeverity(value: unknown): value is Severity {
	return value === "error" || value === "warning" || value === "info";
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function mergeRouting(
	base: LinterConfig["routing"],
	raw: z.infer<typeof routingConfigSchema>,
	configPath: string,
): LinterConfig["routing"] {
	const result = { ...base };
	if (raw.provider !== undefined) {
		result.provider = raw.provider;
	}
	for (const key of ["url", "overpass_url", "cache_dir", "pbf_path"] as const) {
		const value = raw[key];
		if (value !== undefined && value !== "") {
			result[key] = value;
		}
	}
	if (raw.cache !== undefined) {
		result.cache = raw.cache;
	}
	if (raw.pbf_path !== undefined && raw.pbf_path !== "") {
		result.pbf_path = path.resolve(path.dirname(configPath), raw.pbf_path);
	}
	return result;
}

function mergeReporting(
	base: LinterConfig["reporting"],
	raw: z.infer<typeof reportingConfigSchema>,
): LinterConfig["reporting"] {
	const result = { ...base };
	if (raw.format !== undefined) {
		result.format = raw.format;
	}
	if (raw.color !== undefined) {
		result.color = raw.color;
	}
	return result;
}

function mergeRouteContext(
	base: LinterConfig["route_context"],
	raw: z.infer<typeof routeContextSchema>,
): LinterConfig["route_context"] {
	const result = { ...base };
	if (raw.route_type !== undefined) {
		result.route_type = raw.route_type;
	}
	if (raw.terrain !== undefined) {
		result.terrain = raw.terrain;
	}
	if (raw.bike_type !== undefined) {
		result.bike_type = raw.bike_type;
	}
	if (raw.expected_access !== undefined) {
		result.expected_access = raw.expected_access;
	}
	if (raw.loop_expected !== undefined) {
		result.loop_expected = raw.loop_expected;
	}
	if (raw.ferry_allowed !== undefined) {
		result.ferry_allowed = raw.ferry_allowed;
	}
	if (raw.ignore_dead_end !== undefined) {
		result.ignore_dead_end = raw.ignore_dead_end;
	}
	return result;
}

// Re-export zod types for external use
export type {
	LinterConfigInput,
	ReportingConfigInput,
	RouteContextInput,
	RoutingConfigInput,
	RuleDefinitionInput,
} from "./configSchema";
