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
