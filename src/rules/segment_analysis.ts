/**
 * Shared segment-level analysis for cycling-facility direction rules.
 *
 * Replaces point-by-point heuristics with run-level evaluation:
 *   • Route edges between consecutive points (same segmentId).
 *   • Grouped into runs by matched OSM way.
 *   • Local tangent comparison against OSM geometry.
 *   • Facility-to-road geometric association.
 *   • Direction normalisation from OSM tags.
 *
 * Both `bike_lane_no_same_direction_car_lane` and `contraflow_bike`
 * import from this module.
 */

import {
	bearingDegrees,
	distanceMeters,
	pointToGeometryDistanceMeters,
} from "../geo";
import type { OsmWay } from "../osm";
import type {
	Confidence,
	DataSourceAvailability,
	MatchResult,
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
	sameSegment,
	uncertaintyResult,
} from "./utils";

// ── Constants ──────────────────────────────────────────────────────

/** Explicitly allowed motor-road highway classes. */
const CAR_ROAD_HIGHWAYS = new Set([
	"motorway",
	"motorway_link",
	"trunk",
	"trunk_link",
	"primary",
	"primary_link",
	"secondary",
	"secondary_link",
	"tertiary",
	"tertiary_link",
	"unclassified",
	"residential",
	"living_street",
	"service",
]);

/** Max angular difference (degrees) for same-direction one-way match. */
const SAME_DIRECTION_ANGLE_DEGREES = 45;

/** Minimum distance (m) between route points to form a meaningful edge. */
const MIN_ROUTE_EDGE_METERS = 0.1;

/** Minimum movement (m) to consider a point as having moved. */
const MIN_ROUTE_BEARING_MOVEMENT_METERS = 0.1;

/** Max distance (m) for facility-to-road association. */
const ASSOCIATION_MAX_DISTANCE_METERS = 50;

/** Angular threshold (degrees) for same-tangent local alignment. */
const ASSOCIATION_ANGLE_DEGREES = 45;

/** Minimum run length (m) for a confident evaluation. */
const MIN_CONFIDENT_RUN_METERS = 0.5;

/** Minimum association score (0-1) to consider a road associated. */
const ASSOCIATION_SCORE_THRESHOLD = 0.3;

// ── Types ──────────────────────────────────────────────────────────

export interface RouteEdge {
	index: number;
	from: Trackpoint;
	to: Trackpoint;
	bearing: number;
	distanceMeters: number;
}

export interface RouteRun {
	edges: RouteEdge[];
	startIndex: number;
	endIndex: number;
	segmentId: number;
	matchedWayId: string | null;
	totalDistanceMeters: number;
}

export interface RoadDirection {
	wayId: string;
	roadName?: string;
	direction: "same" | "opposite" | "both" | "unrelated" | "unknown";
}

export interface AssociationResult {
	wayId: string;
	roadName?: string;
	score: number;
}

export interface FacilityClassification {
	isCyclingFacility: boolean;
	isCyclewayOnMotorRoad: boolean;
	motorRoadId?: string;
	motorRoadTags?: Record<string, string>;
}

// ── Public helpers ─────────────────────────────────────────────────

/**
 * Build route edges between consecutive trackpoints within the same segment.
 * Ignores near-zero movement edges.
 */
export function buildRouteEdges(points: Trackpoint[]): RouteEdge[] {
	const edges: RouteEdge[] = [];
	for (let i = 0; i < points.length - 1; i++) {
		const from = points[i];
		const to = points[i + 1];
		if (!sameSegment(from, to)) continue;

		const dist = distanceMeters(from, to);
		if (dist < MIN_ROUTE_EDGE_METERS) continue;

		edges.push({
			index: i,
			from,
			to,
			bearing: bearingDegrees(from, to),
			distanceMeters: dist,
		});
	}
	return edges;
}

/**
 * Group route edges into runs by segment and matched way identity.
 * A run may cross small gaps but not segment boundaries or major direction changes.
 */
export function buildRouteRuns(
	edges: RouteEdge[],
	matches: RuleContext["matches"],
): RouteRun[] {
	if (edges.length === 0) return [];

	const runs: RouteRun[] = [];
	let currentRun: RouteRun | null = null;

	for (const edge of edges) {
		const match = matches?.[edge.index];
		const wayId = match ? String(match.roadId) : "";

		if (
			!currentRun ||
			edge.from.segmentId !== currentRun.segmentId ||
			(currentRun.matchedWayId !== null && wayId !== currentRun.matchedWayId)
		) {
			if (currentRun) runs.push(currentRun);
			currentRun = {
				edges: [edge],
				startIndex: edge.index,
				endIndex: edge.index + 1,
				segmentId: edge.from.segmentId,
				matchedWayId: wayId || null,
				totalDistanceMeters: edge.distanceMeters,
			};
		} else {
			currentRun.edges.push(edge);
			currentRun.endIndex = edge.index + 1;
			currentRun.totalDistanceMeters += edge.distanceMeters;
		}
	}
	if (currentRun) runs.push(currentRun);
	return runs;
}

/**
 * Classify a matched OSM way as a cycling facility or motor road.
 */
export function classifyFacility(
	tags: Record<string, string>,
): FacilityClassification {
	const highway = (tags.highway ?? "").toLowerCase();
	const bicycle = (tags.bicycle ?? "").toLowerCase();
	const access = (tags.access ?? "").toLowerCase();
	const cycleway = (tags.cycleway ?? "").toLowerCase();
	const cyclewayLeft = (tags["cycleway:left"] ?? "").toLowerCase();
	const cyclewayRight = (tags["cycleway:right"] ?? "").toLowerCase();

	// Explicitly excluded access/bicycle tags on cycleways
	if (access === "no" || bicycle === "no")
		return { isCyclingFacility: false, isCyclewayOnMotorRoad: false };

	// Standalone cycling facility
	if (highway === "cycleway")
		return { isCyclingFacility: true, isCyclewayOnMotorRoad: false };
	if (highway === "path" && bicycle === "designated")
		return { isCyclingFacility: true, isCyclewayOnMotorRoad: false };

	// Cycleway tag on a motor road (cycleway=lane/track/etc. on the way itself)
	if (
		isCarRoad(highway, tags) &&
		(cycleway === "lane" ||
			cycleway === "track" ||
			cycleway === "opposite_lane" ||
			cycleway === "opposite_track")
	) {
		return {
			isCyclingFacility: true,
			isCyclewayOnMotorRoad: true,
			motorRoadTags: tags,
		};
	}
	if (
		isCarRoad(highway, tags) &&
		(cyclewayLeft === "lane" ||
			cyclewayLeft === "track" ||
			cyclewayLeft === "opposite_lane" ||
			cyclewayLeft === "opposite_track")
	) {
		return {
			isCyclingFacility: true,
			isCyclewayOnMotorRoad: true,
			motorRoadTags: tags,
		};
	}
	if (
		isCarRoad(highway, tags) &&
		(cyclewayRight === "lane" ||
			cyclewayRight === "track" ||
			cyclewayRight === "opposite_lane" ||
			cyclewayRight === "opposite_track")
	) {
		return {
			isCyclingFacility: true,
			isCyclewayOnMotorRoad: true,
			motorRoadTags: tags,
		};
	}

	return { isCyclingFacility: false, isCyclewayOnMotorRoad: false };
}

/**
 * Check if an OSM way is a car-carrying road (allowlist).
 */
export function isCarRoad(
	highway: string,
	tags: Record<string, string>,
): boolean {
	const hw = (highway ?? "").toLowerCase();
	if (!CAR_ROAD_HIGHWAYS.has(hw)) return false;
	const motorVehicle = (tags.motor_vehicle ?? "").toLowerCase();
	const access = (tags.access ?? "").toLowerCase();
	if (motorVehicle === "no" || access === "no") return false;
	return true;
}

/**
 * Determine the direction a car road serves relative to a route bearing.
 * Uses nearest segment bearing for accuracy.
 */
export function roadServesDirection(
	tags: Record<string, string>,
	wayGeometry: { lat: number; lon: number }[],
	routeBearing: number,
	point?: Trackpoint,
): "same" | "opposite" | "both" | "unrelated" | "unknown" {
	if (wayGeometry.length < 2) return "unknown";

	const onewayRaw = (tags.oneway ?? "").trim().toLowerCase();
	const highway = (tags.highway ?? "").toLowerCase();

	// Find nearest segment bearing
	let nearestRoadBearing: number | undefined;
	let nearestDistance = Number.POSITIVE_INFINITY;
	if (point) {
		for (let i = 1; i < wayGeometry.length; i++) {
			const start = wayGeometry[i - 1];
			const end = wayGeometry[i];
			if (start.lat === end.lat && start.lon === end.lon) continue;

			const distance = pointToGeometryDistanceMeters(point, {
				type: "LineString",
				coordinates: [
					[start.lon, start.lat],
					[end.lon, end.lat],
				],
			});
			if (distance >= nearestDistance) continue;
			nearestDistance = distance;
			nearestRoadBearing = bearingDegrees(start, end);
		}
	} else {
		// Fall back to first valid segment
		for (let i = 1; i < wayGeometry.length; i++) {
			const start = wayGeometry[i - 1];
			const end = wayGeometry[i];
			if (start.lat === end.lat && start.lon === end.lon) continue;
			nearestRoadBearing = bearingDegrees(start, end);
			break;
		}
	}
	if (nearestRoadBearing === undefined) return "unknown";

	if (
		onewayRaw === "no" ||
		onewayRaw === "0" ||
		onewayRaw === "false" ||
		(!onewayRaw &&
			highway !== "motorway" &&
			highway !== "motorway_link" &&
			tags.junction !== "roundabout")
	) {
		return roadAlignsWithBearing(routeBearing, nearestRoadBearing)
			? "both"
			: "unrelated";
	}

	// Explicit one-way (yes/1/true)
	if (onewayRaw === "yes" || onewayRaw === "1" || onewayRaw === "true") {
		const angularDiff = Math.abs(
			((routeBearing - nearestRoadBearing + 540) % 360) - 180,
		);
		if (angularDiff > SAME_DIRECTION_ANGLE_DEGREES) return "opposite";
		return "same";
	}

	// oneway = -1 (opposite to way direction)
	if (onewayRaw === "-1") {
		const reverseBearing = (nearestRoadBearing + 180) % 360;
		const angularDiff = Math.abs(
			((routeBearing - reverseBearing + 540) % 360) - 180,
		);
		if (angularDiff > SAME_DIRECTION_ANGLE_DEGREES) return "opposite";
		return "same";
	}

	if (onewayRaw && !["yes", "1", "true", "-1"].includes(onewayRaw)) {
		return "unknown";
	}

	// Implicit one-way for motorway, motorway_link, roundabout
	if (
		highway === "motorway" ||
		highway === "motorway_link" ||
		tags.junction === "roundabout"
	) {
		const angularDiff = Math.abs(
			((routeBearing - nearestRoadBearing + 540) % 360) - 180,
		);
		if (angularDiff > SAME_DIRECTION_ANGLE_DEGREES) return "opposite";
		return "same";
	}

	// Untagged ordinary road is two-way
	return roadAlignsWithBearing(routeBearing, nearestRoadBearing)
		? "both"
		: "unrelated";
}

function roadAlignsWithBearing(
	routeBearing: number,
	roadBearing: number,
): boolean {
	const directedDiff = Math.abs(
		((routeBearing - roadBearing + 540) % 360) - 180,
	);
	const undirectedDiff = Math.min(directedDiff, 180 - directedDiff);
	return undirectedDiff <= SAME_DIRECTION_ANGLE_DEGREES;
}

/**
 * Find car roads that are geometrically associated with a route run.
 * Uses sustained proximity + local tangent alignment.
 */
export function findAssociatedCarRoads(
	run: RouteRun,
	osmWays: OsmWay[],
	facilityWayId: string,
): AssociationResult[] {
	const candidates: AssociationResult[] = [];

	for (const way of osmWays) {
		if (String(way.id) === String(facilityWayId)) continue;
		const hw = (way.tags?.highway ?? "").toLowerCase();
		if (!isCarRoad(hw, way.tags)) continue;

		const score = computeAssociationScore(run, way);
		if (score >= ASSOCIATION_SCORE_THRESHOLD) {
			candidates.push({
				wayId: String(way.id),
				roadName: way.tags?.name,
				score,
			});
		}
	}

	// Sort by score descending, take best
	candidates.sort((a, b) => b.score - a.score);
	return candidates;
}

/**
 * Compute an association score (0-1) between a route run and an OSM way.
 * Factors: distance fraction, alignment fraction, coverage fraction.
 */
function computeAssociationScore(run: RouteRun, way: OsmWay): number {
	if (run.totalDistanceMeters < MIN_CONFIDENT_RUN_METERS) return 0;
	if (way.geometry.length < 2) return 0;

	let withinDistance = 0;
	let alignedBearing = 0;
	let coveredLength = 0;
	let totalLength = 0;

	for (const edge of run.edges) {
		const dist = pointToWayDistanceMeters(edge.from, way);
		const _hw = (way.tags?.highway ?? "").toLowerCase();

		// Check layer compatibility
		if (!isLayerCompatible(edge.from, way)) continue;

		totalLength += edge.distanceMeters;

		if (dist <= ASSOCIATION_MAX_DISTANCE_METERS) {
			withinDistance++;

			// Check local alignment
			if (isLocallyAligned(edge, way)) {
				alignedBearing++;
			}

			// Approximate covered length
			if (dist <= ASSOCIATION_MAX_DISTANCE_METERS * 0.5) {
				coveredLength += edge.distanceMeters;
			}
		}
	}

	if (totalLength === 0) return 0;

	const distanceFraction = withinDistance / run.edges.length;
	const alignmentFraction = alignedBearing / run.edges.length;
	const coverageFraction = coveredLength / totalLength;

	// Weighted score
	return (
		distanceFraction * 0.4 + alignmentFraction * 0.4 + coverageFraction * 0.2
	);
}

/**
 * Check if a route edge is locally aligned with an OSM way.
 * Compares the edge bearing to the nearest OSM segment bearing.
 */
function isLocallyAligned(edge: RouteEdge, way: OsmWay): boolean {
	if (way.geometry.length < 2) return false;

	let minAngularDiff = 360;

	for (let i = 1; i < way.geometry.length; i++) {
		const start = way.geometry[i - 1];
		const end = way.geometry[i];
		if (start.lat === end.lat && start.lon === end.lon) continue;

		const segBearing = bearingDegrees(start, end);
		const angularDiff = Math.abs(
			((edge.bearing - segBearing + 540) % 360) - 180,
		);
		const effectiveDiff = Math.min(angularDiff, 180 - angularDiff);

		const dist = pointToGeometryDistanceMeters(edge.from, {
			type: "LineString",
			coordinates: [
				[start.lon, start.lat],
				[end.lon, end.lat],
			],
		});

		if (dist <= ASSOCIATION_MAX_DISTANCE_METERS) {
			minAngularDiff = Math.min(minAngularDiff, effectiveDiff);
		}
	}

	return minAngularDiff <= ASSOCIATION_ANGLE_DEGREES;
}

/**
 * Check OSM layer/bridge/tunnel compatibility.
 */
function isLayerCompatible(point: Trackpoint, way: OsmWay): boolean {
	const layer = way.tags?.layer;
	if (layer === undefined) return true;

	const pointLayer = point.ele === null ? null : null;
	if (pointLayer === null && layer !== undefined) {
		// No layer info on point, allow (conservative: don't reject)
		return true;
	}

	try {
		const layerNum = parseFloat(layer);
		// If way has explicit layer, prefer it (don't reject by default)
		return Math.abs(layerNum) < 10; // Reasonable layer values
	} catch {
		return true;
	}
}

/**
 * Calculate the minimum distance from a point to an OSM way.
 */
function pointToWayDistanceMeters(point: Trackpoint, way: OsmWay): number {
	if (way.geometry.length < 2) return Number.POSITIVE_INFINITY;

	const coordinates: [number, number][] = way.geometry.map(
		(g: { lat: number; lon: number }) => [g.lon, g.lat],
	);
	return pointToGeometryDistanceMeters(point, {
		type: "LineString",
		coordinates,
	});
}

/**
 * Get the route bearing for a point (within same segment).
 */
export function getRouteBearing(
	points: Trackpoint[],
	index: number,
): number | undefined {
	const current = points[index];
	const nextPoint = findRouteBearingNeighbor(points, index, 1);
	if (nextPoint) return bearingDegrees(current, nextPoint);

	const previousPoint = findRouteBearingNeighbor(points, index, -1);
	if (previousPoint) return bearingDegrees(previousPoint, current);
	return undefined;
}

function findRouteBearingNeighbor(
	points: Trackpoint[],
	index: number,
	step: -1 | 1,
): Trackpoint | undefined {
	const current = points[index];
	let nearestMovingPoint: Trackpoint | undefined;
	for (
		let neighborIndex = index + step;
		neighborIndex >= 0 && neighborIndex < points.length;
		neighborIndex += step
	) {
		const neighbor = points[neighborIndex];
		if (neighbor.segmentId !== current.segmentId) break;

		const movement = distanceMeters(current, neighbor);
		if (movement >= MIN_ROUTE_EDGE_METERS) return neighbor;
		if (
			movement >= MIN_ROUTE_BEARING_MOVEMENT_METERS &&
			nearestMovingPoint === undefined
		) {
			nearestMovingPoint = neighbor;
		}
	}
	return nearestMovingPoint;
}

// ── Rule context type (minimal) ────────────────────────────────────

export interface RuleContext {
	rules?: Record<string, RuleDefinition>;
	roadMatching?: DataSourceAvailability;
	matches?: MatchResult[];
	roadMatches?: MatchResult[];
	routeContext?: import("../types").LinterConfig["route_context"];
	osmWays?: import("./../osm").OsmWay[];
	osmWaysAvailability?: DataSourceAvailability;
}

// ── Rule evaluation helpers ────────────────────────────────────────

/**
 * Evaluate `bike_lane_no_same_direction_car_lane` using segment-level analysis.
 */
export function evaluateBikeLaneNoSameDirectionCarLane(
	definition: RuleDefinition,
	points: Trackpoint[],
	context: RuleContext,
): RuleResult[] {
	if (context.roadMatching?.status === "unavailable") {
		return [
			result(
				"bike_lane_no_same_direction_car_lane",
				definition,
				"warning",
				"unknown",
				"Road matching is unavailable; same-direction car road could not be evaluated.",
				"low",
				undefined,
				{ source: context.roadMatching.source },
			),
		];
	}

	const matches = context.matches ?? [];
	const osmWays = context.osmWays ?? [];
	const osmWaysAvailable =
		context.osmWaysAvailability?.status === "complete" ||
		(context.osmWaysAvailability === undefined &&
			context.osmWays !== undefined);

	const edges = buildRouteEdges(points);
	const runs = buildRouteRuns(edges, matches);

	const failures: RuleResult[] = [];
	const uncertainties: RuleResult[] = [];
	let evaluated = 0;

	for (const run of runs) {
		if (run.totalDistanceMeters < MIN_CONFIDENT_RUN_METERS) {
			// Too short to evaluate confidently
			for (const edge of run.edges) {
				const match = matches?.[edge.index];
				if (
					!isConfidentMatch(
						match ?? { status: "unmatched", confidence: "unknown" },
					)
				) {
					uncertainties.push(
						uncertaintyResult(
							"bike_lane_no_same_direction_car_lane",
							definition,
							points[edge.index],
							match ??
								({ status: "unmatched", confidence: "unknown" } as MatchResult),
						),
					);
				}
			}
			continue;
		}

		// Classify the facility
		const firstEdge = run.edges[0];
		const match = matches?.[firstEdge.index];
		if (!match) {
			for (const edge of run.edges) {
				uncertainties.push(
					uncertaintyResult(
						"bike_lane_no_same_direction_car_lane",
						definition,
						points[edge.index],
						{ status: "unmatched", confidence: "unknown" } as MatchResult,
					),
				);
			}
			continue;
		}

		if (!isConfidentMatch(match)) {
			uncertainties.push(
				uncertaintyResult(
					"bike_lane_no_same_direction_car_lane",
					definition,
					points[run.startIndex],
					match,
				),
			);
			continue;
		}

		const matchedWayId = String(match.roadId);
		const matchedWay = osmWays.find((w) => String(w.id) === matchedWayId);
		const tags = matchedWay?.tags ?? match.tags;

		if (!tags) {
			for (const edge of run.edges) {
				uncertainties.push(
					result(
						"bike_lane_no_same_direction_car_lane",
						definition,
						"warning",
						"unknown",
						"Matched way has no OSM tags; facility type cannot be determined.",
						"low",
						points[edge.index],
						{ roadId: matchedWayId },
						{ provider: match.provider },
					),
				);
			}
			continue;
		}

		const classification = classifyFacility(tags);

		if (!classification.isCyclingFacility) {
			evaluated += run.edges.length;
			continue;
		}

		// Get route bearing for this run
		const avgBearing = run.edges.length > 0 ? run.edges[0].bearing : undefined;
		if (avgBearing === undefined) {
			for (const edge of run.edges) {
				uncertainties.push(
					result(
						"bike_lane_no_same_direction_car_lane",
						definition,
						"warning",
						"unknown",
						"Route bearing is unavailable for this run; direction cannot be established.",
						"low",
						points[edge.index],
						{ facilityRoadId: matchedWayId },
						{ provider: match.provider },
					),
				);
			}
			continue;
		}

		let hasSameDirectionRoad = false;
		let associatedRoadCount = 0;
		let hasUnknownDirection = false;

		if (classification.isCyclewayOnMotorRoad) {
			// Cycleway tag on motor road — evaluate the motor road directly
			const motorTags = classification.motorRoadTags ?? tags;
			// The route IS on the cycleway, but the motor road is the same OSM way
			// Check if the motor road serves the route direction
			const direction = roadServesDirection(
				motorTags,
				matchedWay?.geometry ?? [],
				avgBearing,
				points[run.startIndex],
			);
			if (direction === "same" || direction === "both") {
				hasSameDirectionRoad = true;
			} else if (direction === "unknown") {
				for (const edge of run.edges) {
					uncertainties.push(
						result(
							"bike_lane_no_same_direction_car_lane",
							definition,
							"warning",
							"unknown",
							"Motor road direction is uncertain; same-direction status could not be determined.",
							"low",
							points[edge.index],
							{ facilityRoadId: matchedWayId },
							{ provider: match.provider },
						),
					);
				}
			}
		} else {
			// Standalone cycleway — find associated motor road
			const associatedRoads = findAssociatedCarRoads(
				run,
				osmWays,
				matchedWayId,
			);
			associatedRoadCount = associatedRoads.length;

			for (const assoc of associatedRoads) {
				const assocWay = osmWays.find((w) => String(w.id) === assoc.wayId);
				if (!assocWay) continue;

				const direction = roadServesDirection(
					assocWay.tags ?? {},
					assocWay.geometry,
					avgBearing,
					points[run.startIndex],
				);

				if (direction === "same" || direction === "both") {
					hasSameDirectionRoad = true;
					break;
				}
				if (direction === "unknown") {
					hasUnknownDirection = true;
				}
			}

			// If no associated roads found, check osmWaysAvailable
			if (
				!hasSameDirectionRoad &&
				associatedRoads.length === 0 &&
				!osmWaysAvailable
			) {
				for (const edge of run.edges) {
					uncertainties.push(
						result(
							"bike_lane_no_same_direction_car_lane",
							definition,
							"warning",
							"unknown",
							"OSM way data is incomplete; nearby same-direction car roads could not be ruled out.",
							"low",
							points[edge.index],
							{
								facilityRoadId: matchedWayId,
								osmStatus: context.osmWaysAvailability?.status ?? "unavailable",
							},
							{ provider: match.provider },
						),
					);
				}
			}
		}

		if (hasSameDirectionRoad) {
			evaluated += run.edges.length;
		} else if (hasUnknownDirection) {
			for (const edge of run.edges) {
				uncertainties.push(
					result(
						"bike_lane_no_same_direction_car_lane",
						definition,
						"warning",
						"unknown",
						"A nearby car road has an unrecognized direction tag; same-direction traffic could not be determined.",
						"low",
						points[edge.index],
						{
							facilityRoadId: matchedWayId,
							candidateRoadCount: associatedRoadCount,
						},
						{ provider: match.provider },
					),
				);
			}
		} else if (!osmWaysAvailable) {
			for (const edge of run.edges) {
				uncertainties.push(
					result(
						"bike_lane_no_same_direction_car_lane",
						definition,
						"warning",
						"unknown",
						"OSM way data is incomplete; nearby same-direction car roads could not be ruled out.",
						"low",
						points[edge.index],
						{
							facilityRoadId: matchedWayId,
							osmStatus: context.osmWaysAvailability?.status ?? "unavailable",
						},
						{ provider: match.provider },
					),
				);
			}
		} else {
			// No qualifying car road found — fail
			const confidence: Confidence =
				match.confidence === "unknown" ? "low" : match.confidence;
			for (const edge of run.edges) {
				failures.push(
					result(
						"bike_lane_no_same_direction_car_lane",
						definition,
						"warning",
						"fail",
						`Route travels on a dedicated cycling facility (way ${matchedWayId}) with no nearby car road serving the same direction.`,
						confidence,
						points[edge.index],
						{
							facilityRoadId: matchedWayId,
							facilityHighway: tags.highway,
							bicycle: tags.bicycle ?? null,
							routeBearing: avgBearing,
							candidateRoadCount: associatedRoadCount,
						},
						{ provider: match.provider },
					),
				);
			}
		}
	}

	return buildSummaryResult(
		"bike_lane_no_same_direction_car_lane",
		definition,
		failures,
		uncertainties,
		evaluated,
		"No dedicated cycling facilities without same-direction car roads were found.",
	);
}

/**
 * Evaluate `contraflow_bike` using segment-level analysis.
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

	const edges = buildRouteEdges(points);
	const runs = buildRouteRuns(edges, matches);

	const failures: RuleResult[] = [];
	const uncertainties: RuleResult[] = [];
	let evaluated = 0;

	for (const run of runs) {
		const firstEdge = run.edges[0];
		const match = matches?.[firstEdge.index];

		if (
			!isConfidentMatch(match ?? { status: "unmatched", confidence: "unknown" })
		) {
			for (const edge of run.edges) {
				uncertainties.push(
					uncertaintyResult(
						"contraflow_bike",
						definition,
						points[edge.index],
						match ??
							({ status: "unmatched", confidence: "unknown" } as MatchResult),
					),
				);
			}
			continue;
		}

		const matchedWayId = String(match.roadId);
		const matchedWay = context.osmWays?.find(
			(w) => String(w.id) === matchedWayId,
		);
		const tags = matchedWay?.tags ?? match.tags;

		if (!tags || tags.oneway === undefined) {
			evaluated += run.edges.length;
			continue;
		}

		if (
			isOneWay(tags.oneway) &&
			(match.direction === undefined || match.direction === "unknown")
		) {
			for (const edge of run.edges) {
				uncertainties.push(
					result(
						"contraflow_bike",
						definition,
						"error",
						"unknown",
						"The matched road direction is unavailable, so contraflow cannot be determined.",
						"low",
						points[edge.index],
						{ roadId: matchedWayId, oneway: tags.oneway },
						{ provider: match.provider },
					),
				);
			}
			continue;
		}

		if (!isOneWay(tags.oneway) && !isTwoWay(tags.oneway)) {
			for (const edge of run.edges) {
				uncertainties.push(
					result(
						"contraflow_bike",
						definition,
						"error",
						"unknown",
						`OSM uses an unsupported oneway value "${tags.oneway}".`,
						"low",
						points[edge.index],
						{ roadId: matchedWayId, oneway: tags.oneway },
						{ provider: match.provider },
					),
				);
			}
			continue;
		}

		// Check if this is a cycle track on a separate way (not the motor road itself)
		const classification = classifyFacility(tags);
		const isOnSeparateCycleTrack =
			classification.isCyclingFacility &&
			classification.isCyclewayOnMotorRoad === false;

		const againstDirection =
			tags.oneway === "-1"
				? match.direction === "forward"
				: isOneWay(tags.oneway) && match.direction === "backward";

		const exception = hasBikeContraflow(tags);

		// Don't contraflow on separate cycle track — that's handled by bike_lane rule
		if (againstDirection && !exception && !isOnSeparateCycleTrack) {
			const confidence: Confidence =
				match.confidence === "unknown" ? "low" : match.confidence;
			for (const edge of run.edges) {
				failures.push(
					result(
						"contraflow_bike",
						definition,
						"error",
						"fail",
						`Route travels against one-way road "${match.roadName ?? matchedWayId ?? "unknown"}" without a bicycle contraflow exception.`,
						confidence,
						points[edge.index],
						{
							roadId: matchedWayId,
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
		} else {
			evaluated += run.edges.length;
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
