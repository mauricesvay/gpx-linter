import { pointToGeometryDistanceMeters, bearingDegrees } from "../geo";
import type { MatchResult, Trackpoint } from "../types";
import { confidenceFromScore } from "../utils";
import {
	GRID_CELL_DEGREES,
	HIGHWAY_PRIORITY,
	MAX_SNAP_DISTANCE_METERS,
	AMBIGUITY_GAP_METERS,
	type OsmWay,
} from "./cache";

/* ── local snapping types ────────────────────────────────────────────── */

export interface IndexedWay {
	way: OsmWay;
	coordinates: [number, number][];
	latMin: number;
	lonMin: number;
	latMax: number;
	lonMax: number;
}

export interface ScoredCandidate {
	way: OsmWay;
	distance: number;
	combinedScore: number;
}

/* ── grid index ──────────────────────────────────────────────────────── */

export function buildWayIndex(ways: OsmWay[]): {
	cells: Map<string, number[]>;
	indexed: IndexedWay[];
} {
	const cells = new Map<string, number[]>();
	const indexed: IndexedWay[] = [];
	for (const way of ways) {
		let latMin = 90,
			lonMin = 180,
			latMax = -90,
			lonMax = -180;
		const coordinates: [number, number][] = [];
		for (const position of way.geometry) {
			coordinates.push([position.lon, position.lat]);
			latMin = Math.min(latMin, position.lat);
			lonMin = Math.min(lonMin, position.lon);
			latMax = Math.max(latMax, position.lat);
			lonMax = Math.max(lonMax, position.lon);
		}
		const index = indexed.length;
		indexed.push({ way, coordinates, latMin, lonMin, latMax, lonMax });
		const left = Math.floor(lonMin / GRID_CELL_DEGREES);
		const right = Math.floor(lonMax / GRID_CELL_DEGREES);
		const bottom = Math.floor(latMin / GRID_CELL_DEGREES);
		const top = Math.floor(latMax / GRID_CELL_DEGREES);
		for (let cy = bottom; cy <= top; cy++) {
			for (let cx = left; cx <= right; cx++) {
				const key = `${cx}:${cy}`;
				const bucket = cells.get(key);
				if (bucket) bucket.push(index);
				else cells.set(key, [index]);
			}
		}
	}
	return { cells, indexed };
}

/* ── single-point snapping ───────────────────────────────────────────── */

function computeBearingConsistency(
	point: Trackpoint,
	routeBearing: number,
	geometry: { lat: number; lon: number }[],
): number {
	let nearestIndex = -1;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (let index = 1; index < geometry.length; index++) {
		const distance = pointToGeometryDistanceMeters(point, {
			type: "LineString",
			coordinates: [geometry[index - 1], geometry[index]].map(
				(position) => [position.lon, position.lat] as [number, number],
			),
		});
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestIndex = index;
		}
	}
	if (nearestIndex < 1) return 0.5;
	const roadBearing = bearingDegrees(
		geometry[nearestIndex - 1],
		geometry[nearestIndex],
	);
	const angularDifference = Math.abs(
		((routeBearing - roadBearing + 540) % 360) - 180,
	);
	return Math.max(0, 1 - angularDifference / 180);
}

function resolveDirection(
	point: Trackpoint,
	routeBearing: number,
	geometry: { lat: number; lon: number }[],
): "forward" | "backward" | "unknown" {
	let nearestIndex = -1;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (let index = 1; index < geometry.length; index++) {
		const distance = pointToGeometryDistanceMeters(point, {
			type: "LineString",
			coordinates: [geometry[index - 1], geometry[index]].map(
				(position) => [position.lon, position.lat] as [number, number],
			),
		});
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestIndex = index;
		}
	}
	if (nearestIndex < 1) return "unknown";
	const roadBearing = bearingDegrees(
		geometry[nearestIndex - 1],
		geometry[nearestIndex],
	);
	const angularDifference = Math.abs(
		((routeBearing - roadBearing + 540) % 360) - 180,
	);
	return angularDifference <= 90 ? "forward" : "backward";
}

function getRouteBearing(
	points: Trackpoint[],
	index: number,
): number | undefined {
	const nextPoint =
		points[index + 1]?.segmentId === points[index].segmentId
			? points[index + 1]
			: points[index - 1]?.segmentId === points[index].segmentId
				? points[index - 1]
				: undefined;
	if (!nextPoint) return undefined;
	const forward = index + 1 < points.length && nextPoint === points[index + 1];
	return bearingDegrees(
		forward ? points[index] : nextPoint,
		forward ? nextPoint : points[index],
	);
}

/**
 * Snap a single trackpoint to the best-matching OSM way using the
 * pre-built grid index.  Shared by `snapPointsToWays` and
 * `enrichMatches` to avoid duplicating grid lookup, bbox rejection,
 * candidate scoring, and ambiguity detection.
 */
export function snapSinglePoint(
	point: Trackpoint,
	index: number,
	points: Trackpoint[],
	cells: Map<string, number[]>,
	indexed: IndexedWay[],
	prevRoadId: string | null,
): {
	nearMiss: boolean;
	ambiguous: boolean;
	topScore: number;
	topCandidate: ScoredCandidate | null;
	allCandidates: ScoredCandidate[];
	direction: "forward" | "backward" | "unknown";
} {
	const cellX = Math.floor(point.lon / GRID_CELL_DEGREES);
	const cellY = Math.floor(point.lat / GRID_CELL_DEGREES);
	const seen = new Set<number>();
	const candidateIndexes: number[] = [];
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			const bucket = cells.get(`${cellX + dx}:${cellY + dy}`);
			if (!bucket) continue;
			for (const ci of bucket) {
				if (!seen.has(ci)) {
					seen.add(ci);
					candidateIndexes.push(ci);
				}
			}
		}
	}

	// bbox fast-reject (100m ≈ 0.0009°)
	const latDeg = 100 / 111_320;
	const lonDeg = 100 / (111_320 * Math.cos((point.lat * Math.PI) / 180));
	const candidates: ScoredCandidate[] = [];
	for (const ci of candidateIndexes) {
		const entry = indexed[ci];
		if (
			point.lat - latDeg > entry.latMax ||
			point.lat + latDeg < entry.latMin ||
			point.lon - lonDeg > entry.lonMax ||
			point.lon + lonDeg < entry.lonMin
		)
			continue;
		const distance = pointToGeometryDistanceMeters(point, {
			type: "LineString",
			coordinates: entry.coordinates,
		});
		if (distance <= MAX_SNAP_DISTANCE_METERS) {
			candidates.push({ way: entry.way, distance, combinedScore: 0 });
		}
	}

	if (candidates.length === 0) {
		return {
			nearMiss: true,
			ambiguous: false,
			topScore: 0,
			topCandidate: null,
			allCandidates: [],
			direction: "unknown",
		};
	}

	// Score candidates: distance 50%, bearing 30%, road class 20%
	const routeBearing = getRouteBearing(points, index);
	for (const c of candidates) {
		const distanceScore = 1 - c.distance / MAX_SNAP_DISTANCE_METERS;
		const bearingScore =
			routeBearing !== undefined
				? computeBearingConsistency(point, routeBearing, c.way.geometry)
				: 1;
		const classScore = (HIGHWAY_PRIORITY[c.way.tags.highway] ?? 0) / 7;
		// Spatial continuity bonus: prefer previously matched road
		let continuityBonus = 0;
		if (prevRoadId && c.way.id.toString() === prevRoadId) {
			continuityBonus = 0.2;
		}
		c.combinedScore =
			distanceScore * 0.5 +
			bearingScore * 0.3 +
			classScore * 0.2 +
			continuityBonus;
	}
	candidates.sort((a, b) => b.combinedScore - a.combinedScore);
	const topCandidate = candidates[0];
	const score = Math.max(0, topCandidate.combinedScore);

	// Ambiguous if top candidates have similar combined scores
	const ambiguous =
		candidates.length > 1 &&
		candidates[0].combinedScore - candidates[1].combinedScore <= 0.15;

	const direction =
		routeBearing === undefined
			? "unknown"
			: resolveDirection(point, routeBearing, topCandidate.way.geometry);

	return {
		nearMiss: false,
		ambiguous,
		topScore: score,
		topCandidate,
		allCandidates: candidates,
		direction,
	};
}

/* ── public: snap all points ─────────────────────────────────────────── */

export function snapPointsToWays(
	points: Trackpoint[],
	ways: OsmWay[],
	provider = "overpass",
): MatchResult[] {
	if (ways.length === 0) {
		return points.map((point) => ({
			status: "unmatched",
			confidence: "unknown",
			score: 0,
			reason: "No OSM road data was available.",
			provider,
		}));
	}

	const { cells, indexed } = buildWayIndex(ways);
	const results: MatchResult[] = [];

	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		const prevResult = results.length > 0 ? results[results.length - 1] : null;
		const prevRoadId =
			prevResult && prevResult.roadId ? String(prevResult.roadId) : null;

		const snap = snapSinglePoint(
			point,
			index,
			points,
			cells,
			indexed,
			prevRoadId,
		);

		if (snap.nearMiss) {
			results.push({
				status: "unmatched",
				confidence: "unknown",
				score: 0,
				reason: `No OSM road geometry was found within ${MAX_SNAP_DISTANCE_METERS}m of the trackpoint.`,
				provider,
			});
			continue;
		}

		const confidence = confidenceFromScore(snap.topScore);
		const { topCandidate } = snap;

		if (snap.ambiguous) {
			results.push({
				status: "ambiguous",
				confidence: "low",
				score: snap.topScore,
				reason: "Multiple nearby OSM roads have similarly plausible distances.",
				roadId: String(topCandidate!.way.id),
				roadName: topCandidate!.way.tags.name,
				distanceToRoad: topCandidate!.distance,
				osmDistanceToRoad: topCandidate!.distance,
				tags: topCandidate!.way.tags,
				direction: snap.direction,
				provider,
				candidates: snap.allCandidates.slice(0, 5).map((c) => ({
					roadId: String(c.way.id),
					score: Math.max(0, c.combinedScore),
					highway: c.way.tags.highway,
					distanceToRoad: c.distance,
				})),
			});
			continue;
		}

		results.push({
			status: confidence === "low" ? "ambiguous" : "matched",
			confidence,
			score: snap.topScore,
			roadId: String(topCandidate!.way.id),
			roadName: topCandidate!.way.tags.name,
			distanceToRoad: topCandidate!.distance,
			osmDistanceToRoad: topCandidate!.distance,
			tags: topCandidate!.way.tags,
			direction: snap.direction,
			provider,
		});
	}
	return results;
}
