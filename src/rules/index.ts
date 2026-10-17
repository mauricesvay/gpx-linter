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
export { loopClosure } from "./loop_closure";
export { maxSlope } from "./max_slope";
export { missingElevation } from "./missing_elevation";
export { evaluateContraflowBike } from "./contraflow_bike";
export { evaluateOffRoad } from "./off_road";
export { evaluateBikeLaneNoSameDirectionCarLane } from "./bike_lane_no_same_direction_car_lane";
export { roadworks } from "./roadworks";
export { routeGaps } from "./route_gaps";
export { sharpTurns } from "./sharp_turns";
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
export {
	buildRouteEdges,
	buildRouteRuns,
	classifyFacility,
	findAssociatedCarRoads,
	getRouteBearing,
	isCarRoad,
	roadServesDirection,
} from "./segment_analysis";

// Rule parameter schemas — exported for configSchema composition.
export { maxSlopeParamsSchema } from "./max_slope";
export { sharpTurnsParamsSchema } from "./sharp_turns";
export { routeGapsParamsSchema } from "./route_gaps";
export { loopClosureParamsSchema } from "./loop_closure";
export { roadworksParamsSchema } from "./roadworks";
export { offRoadParamsSchema } from "./off_road";
export { missingElevationParamsSchema } from "./missing_elevation";
export { contraflowBikeParamsSchema } from "./contraflow_bike";
export { bikeLaneNoSameDirectionCarLaneParamsSchema } from "./bike_lane_no_same_direction_car_lane";

// Rule parameter input types.
export type { MaxSlopeParamsInput } from "./max_slope";
export type { SharpTurnsParamsInput } from "./sharp_turns";
export type { RouteGapsParamsInput } from "./route_gaps";
export type { LoopClosureParamsInput } from "./loop_closure";
export type { RoadworksParamsInput } from "./roadworks";
export type { OffRoadParamsInput } from "./off_road";
export type { MissingElevationParamsInput } from "./missing_elevation";
export type { ContraflowBikeParamsInput } from "./contraflow_bike";
export type { BikeLaneNoSameDirectionCarLaneParamsInput } from "./bike_lane_no_same_direction_car_lane";

// Segment analysis types.
export type {
	RouteEdge,
	RouteRun,
	RoadDirection,
	AssociationResult,
	FacilityClassification,
} from "./segment_analysis";
