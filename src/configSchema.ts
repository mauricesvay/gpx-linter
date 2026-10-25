import { z } from "zod";

import {
	bikeLaneNoSameDirectionCarLaneParamsSchema,
	contraflowBikeParamsSchema,
	loopClosureParamsSchema,
	maxSlopeParamsSchema,
	missingElevationParamsSchema,
	offRoadParamsSchema,
	roadworksParamsSchema,
	routeGapsParamsSchema,
	sharpTurnsParamsSchema,
} from "./rules";

/**
 * Zod schemas for validating GPX lint configuration.
 *
 * These schemas provide runtime validation with clear error messages,
 * replacing the manual validation logic that was scattered across
 * config.ts and validateConfig().
 *
 * Rule-specific schemas are collocated with their respective rule files
 * in src/rules/ and re-exported from src/rules/index.ts.
 */

// Severity enum
const severitySchema = z.enum(["error", "warning", "info"]);

// Rule severity (optional)
const ruleSeveritySchema = severitySchema.optional();

// Rule definition schema — composes a generic definition
// with per-rule parameter schemas via record union.
export const ruleDefinitionSchema = z.object({
	enabled: z.boolean().optional(),
	severity: ruleSeveritySchema,
	description: z.string().optional(),
	params: z.record(z.unknown()).optional(),
	data: z.unknown().optional(),
});

// Routing provider
const routingProviderSchema = z.enum(["overpass", "offline"]);

// URL validation helper
const httpUrlSchema = z.string().url().or(z.literal(""));

// Routing configuration schema
export const routingConfigSchema = z.object({
	provider: routingProviderSchema.optional(),
	url: httpUrlSchema.optional(),
	overpass_url: httpUrlSchema.optional(),
	pbf_path: z.string().optional(),
	cache: z.boolean().optional(),
	cache_dir: z.string().optional(),
});

// Reporting configuration schema
export const reportingConfigSchema = z.object({
	format: z.enum(["text", "json", "html"]).optional(),
	color: z.enum(["auto", "always", "never"]).optional(),
});

// Route context schema
export const routeContextSchema = z.object({
	route_type: z.string().optional(),
	loop_expected: z.boolean().optional(),
	terrain: z.string().optional(),
	bike_type: z.string().optional(),
	expected_access: z.string().optional(),
	ferry_allowed: z.boolean().optional(),
	ignore_dead_end: z.boolean().optional(),
});

// Full linter config schema
export const linterConfigSchema = z.object({
	rules: z.record(ruleDefinitionSchema).optional(),
	routing: routingConfigSchema.optional(),
	reporting: reportingConfigSchema.optional(),
	route_context: routeContextSchema.optional(),
});

// Per-rule parameter schemas — re-exported for consumers.
export {
	bikeLaneNoSameDirectionCarLaneParamsSchema,
	contraflowBikeParamsSchema,
	loopClosureParamsSchema,
	maxSlopeParamsSchema,
	missingElevationParamsSchema,
	offRoadParamsSchema,
	roadworksParamsSchema,
	routeGapsParamsSchema,
	sharpTurnsParamsSchema,
};

// Export types derived from schemas
export type LinterConfigInput = z.infer<typeof linterConfigSchema>;
export type RuleDefinitionInput = z.infer<typeof ruleDefinitionSchema>;
export type RoutingConfigInput = z.infer<typeof routingConfigSchema>;
export type ReportingConfigInput = z.infer<typeof reportingConfigSchema>;
export type RouteContextInput = z.infer<typeof routeContextSchema>;
export type BikeLaneNoSameDirectionCarLaneParamsInput = z.infer<
	typeof bikeLaneNoSameDirectionCarLaneParamsSchema
>;
