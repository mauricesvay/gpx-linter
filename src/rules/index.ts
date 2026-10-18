/**
 * Rules module — exports all built-in linter rules and shared helpers.
 *
 * Built-in rules:
 *   max_slope       — Detect steep uphill and downhill segments.
 *   roadworks       — Flag proximity to construction zones (GeoJSON).
 *   sharp_turn      — Detect sharp directional changes (turns).
 *   missing_elevation — Report percentage of trackpoints lacking elevation.
 *   route_gaps      — Identify large GPS signal-loss gaps between points.
 *   loop_closure    — Check that loop routes start and end near each other.
 *   contraflow_bike — Detect routes travelling against one-way roads
 *                     without a bicycle contraflow exception (road-dependent).
 *   off_road        — Flag trackpoints too far from any matched road
 *                     (road-dependent).
 *   bike_lane_no_same_direction_car_lane
 *                   — Detect dedicated cycling facilities without a nearby
 *                     same-direction car road (road-dependent).
 *
 * Helpers (utils):
 *   result, numberParam, sameSegment, smoothElevations,
 *   hasBikeContraflow, isOneWay, isTwoWay, isFeatureCollection,
 *   isConfidentMatch, uncertaintyResult, buildSummaryResult
 */

export { evaluateRules } from "../engine";
export type { BikeLaneNoSameDirectionCarLaneParamsInput } from "./bike_lane_no_same_direction_car_lane";
export {
	bikeLaneNoSameDirectionCarLaneParamsSchema,
	evaluateBikeLaneNoSameDirectionCarLane,
} from "./bike_lane_no_same_direction_car_lane";
export type { ContraflowBikeParamsInput } from "./contraflow_bike";
export {
	contraflowBikeParamsSchema,
	evaluateContraflowBike,
} from "./contraflow_bike";
export type { LoopClosureParamsInput } from "./loop_closure";
export { loopClosure, loopClosureParamsSchema } from "./loop_closure";
// Rule parameter input types.
export type { MaxSlopeParamsInput } from "./max_slope";
// Rule parameter schemas — exported for configSchema composition.
export { maxSlope, maxSlopeParamsSchema } from "./max_slope";
export type { MissingElevationParamsInput } from "./missing_elevation";
export {
	missingElevation,
	missingElevationParamsSchema,
} from "./missing_elevation";
export type { OffRoadParamsInput } from "./off_road";
export { evaluateOffRoad, offRoadParamsSchema } from "./off_road";
export type { RoadworksParamsInput } from "./roadworks";
export { roadworks, roadworksParamsSchema } from "./roadworks";
export type { RouteGapsParamsInput } from "./route_gaps";
export { routeGaps, routeGapsParamsSchema } from "./route_gaps";
// Segment analysis types.
export type {
	AssociationResult,
	FacilityClassification,
	RoadDirection,
	RouteEdge,
	RouteRun,
} from "./segment_analysis";
export {
	buildRouteEdges,
	buildRouteRuns,
	classifyFacility,
	findAssociatedCarRoads,
	getRouteBearing,
	isCarRoad,
	roadServesDirection,
} from "./segment_analysis";
export type { SharpTurnsParamsInput } from "./sharp_turns";
export { sharpTurns, sharpTurnsParamsSchema } from "./sharp_turns";
export {
	buildSummaryResult,
	hasBikeContraflow,
	isConfidentMatch,
	isFeatureCollection,
	isOneWay,
	isTwoWay,
	numberParam,
	result,
	sameSegment,
	smoothElevations,
	uncertaintyResult,
} from "./utils";
