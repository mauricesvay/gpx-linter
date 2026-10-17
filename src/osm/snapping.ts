import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bearingDegrees, pointToGeometryDistanceMeters } from "../geo";
import type {
	CacheStats,
	DataSourceAvailability,
	MatchResult,
	Trackpoint,
} from "../types";
import {
	confidenceFromScore,
	delay,
	errorMessage,
	isRecord,
	retryAfterMilliseconds,
	responseBodyDetail,
	truncateText,
} from "../utils";
import {
	GRID_CELL_DEGREES,
	HIGHWAY_PRIORITY,
	MAX_SNAP_DISTANCE_METERS,
	AMBIGUITY_GAP_METERS,
	OVERPASS_TTL_MS,
	OVERPASS_PRIMARY,
	type OsmBbox,
	type OsmData,
	type OsmDataOptions,
	type OsmEnrichmentResult,
	type OsmWay,
	routeBbox,
	chunkBbox,
} from "./cache";
import { fetchOverpassBboxWays } from "./fetch";

/* ── local snapping ──────────────────────────────────────────────────── */

interface IndexedWay {
	way: OsmWay;
	coordinates: [number, number][];
	latMin: number;
	lonMin: number;
	latMax: number;
	lonMax: number;
}

interface ScoredCandidate {
	way: OsmWay;
	distance: number;
	combinedScore: number;
}

function buildWayIndex(
	ways: OsmWay[],
): { cells: Map<string, number[]>; indexed: IndexedWay[] } {
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
	// 0° difference = 1.0, 90° = 0.5, 180° = 0.0
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
	const forward =
		index + 1 < points.length && nextPoint === points[index + 1];
	return bearingDegrees(
		forward ? points[index] : nextPoint,
		forward ? nextPoint : points[index],
	);
}

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
			results.push({
				status: "unmatched",
				confidence: "unknown",
				score: 0,
				reason: `No OSM road geometry was found within ${MAX_SNAP_DISTANCE_METERS}m of the trackpoint.`,
				provider,
			});
			continue;
		}

		// Score candidates: distance 50%, bearing 30%, road class 20%
		const routeBearing = getRouteBearing(points, index);
		// Spatial continuity: prefer previously matched road
		const prevResult = results.length > 0 ? results[results.length - 1] : null;
		const prevRoadId = prevResult && prevResult.roadId ? String(prevResult.roadId) : null;
		for (const c of candidates) {
			const distanceScore = 1 - c.distance / MAX_SNAP_DISTANCE_METERS;
			const bearingScore = routeBearing !== undefined
				? computeBearingConsistency(point, routeBearing, c.way.geometry)
				: 1;
			const classScore = (HIGHWAY_PRIORITY[c.way.tags.highway] ?? 0) / 7;
			// Spatial continuity bonus: prefer previously matched road
			let continuityBonus = 0;
			if (prevRoadId && c.way.id.toString() === prevRoadId) {
				continuityBonus = 0.2;
			}
			c.combinedScore = distanceScore * 0.5 + bearingScore * 0.3 + classScore * 0.2 + continuityBonus;
		}
		candidates.sort((a, b) => b.combinedScore - a.combinedScore);
		const nearest = candidates[0];
		const score = Math.max(0, nearest.combinedScore);
		const confidence = confidenceFromScore(score);
		const direction =
			routeBearing === undefined
				? "unknown"
				: resolveDirection(point, routeBearing, nearest.way.geometry);

		// Ambiguous if top candidates have similar combined scores
		const ambiguous =
			candidates.length > 1 &&
			candidates[0].combinedScore - candidates[1].combinedScore <= 0.15;

		if (ambiguous) {
			results.push({
				status: "ambiguous",
				confidence: "low",
				score,
				reason: "Multiple nearby OSM roads have similarly plausible distances.",
				roadId: String(nearest.way.id),
				roadName: nearest.way.tags.name,
				distanceToRoad: nearest.distance,
				osmDistanceToRoad: nearest.distance,
				tags: nearest.way.tags,
				direction,
				provider,
				candidates: candidates.slice(0, 5).map((c) => ({
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
			score,
			roadId: String(nearest.way.id),
			roadName: nearest.way.tags.name,
			distanceToRoad: nearest.distance,
			osmDistanceToRoad: nearest.distance,
			tags: nearest.way.tags,
			direction,
			provider,
		});
	}
	return results;
}

/* ── enrichment (backward-compatible, uses chunked fetch) ────────────── */

function enrichMatches(
	points: Trackpoint[],
	matches: MatchResult[],
	ways: OsmWay[],
	suppliedBy: string,
): MatchResult[] {
	const { cells, indexed } = buildWayIndex(ways);
	const results: MatchResult[] = [];

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		if (
			match.status !== "matched" ||
			match.confidence === "low" ||
			match.confidence === "unknown"
		) {
			results.push(match);
			continue;
		}
		const point = points[index];
		const cellX = Math.floor(point.lon / GRID_CELL_DEGREES);
		const cellY = Math.floor(point.lat / GRID_CELL_DEGREES);
		const latDeg = MAX_SNAP_DISTANCE_METERS / 111_320;
		const lonDeg =
			MAX_SNAP_DISTANCE_METERS /
			(111_320 * Math.cos((point.lat * Math.PI) / 180));
		const seen = new Set<number>();
		const candidates: ScoredCandidate[] = [];
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const bucket = cells.get(`${cellX + dx}:${cellY + dy}`);
				if (!bucket) continue;
				for (const ci of bucket) {
					if (seen.has(ci)) continue;
					seen.add(ci);
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
			}
		}
		if (candidates.length === 0) {
			results.push({
				...match,
				status: "unmatched",
				confidence: "unknown",
				reason:
					`No OSM road geometry was found within ${MAX_SNAP_DISTANCE_METERS}m of the matched point.`,
				candidates: [],
			});
			continue;
		}
		const routeBearing = getRouteBearing(points, index);
		// Spatial continuity: prefer previously matched road
		const prevResult = results.length > 0 ? results[results.length - 1] : null;
		const prevRoadId = prevResult && prevResult.roadId ? String(prevResult.roadId) : null;
		for (const c of candidates) {
			const distanceScore = 1 - c.distance / MAX_SNAP_DISTANCE_METERS;
			const bearingScore = routeBearing !== undefined
				? computeBearingConsistency(point, routeBearing, c.way.geometry)
				: 1;
			const classScore = (HIGHWAY_PRIORITY[c.way.tags.highway] ?? 0) / 7;
			// Spatial continuity bonus: prefer previously matched road
			let continuityBonus = 0;
			if (prevRoadId && c.way.id.toString() === prevRoadId) {
				continuityBonus = 0.2;
			}
			c.combinedScore = distanceScore * 0.5 + bearingScore * 0.3 + classScore * 0.2 + continuityBonus;
		}
		candidates.sort((a, b) => b.combinedScore - a.combinedScore);
		const selected = candidates[0];
		const ambiguous =
			candidates.length > 1 &&
			candidates[0].combinedScore - candidates[1].combinedScore <= 0.15;
		if (ambiguous) {
			results.push({
				...match,
				status: "ambiguous",
				confidence: "low",
				reason: "Multiple nearby OSM roads have similarly plausible distances.",
				candidates: candidates.slice(0, 5).map((candidate) => ({
					roadId: String(candidate.way.id),
					score: Math.max(0, candidate.combinedScore),
					highway: candidate.way.tags.highway,
					distanceToRoad: candidate.distance,
				})),
			});
			continue;
		}
		const wayDirection =
			routeBearing === undefined
				? "unknown"
				: resolveDirection(
						point,
						routeBearing,
						selected.way.geometry,
					);
		results.push({
			...match,
			roadId: String(selected.way.id),
			roadName: selected.way.tags.name,
			osmDistanceToRoad: selected.distance,
			tags: selected.way.tags,
			direction: wayDirection,
			provider: match.provider,
		});
	}
	return results;
}

export async function enrichWithOsm(
	points: Trackpoint[],
	matches: MatchResult[],
	options: OsmDataOptions = {},
): Promise<OsmEnrichmentResult> {
	const cache = { hits: 0, misses: 0 };
	let cacheError: string | undefined;

	if (points.length === 0 || points.length !== matches.length) {
		return {
			matches,
			availability: {
				status: points.length === 0 ? "not_required" : "unavailable",
				source: options.url ?? OVERPASS_PRIMARY,
				requestedItems: points.length,
				availableItems: 0,
				message: "No matched route points are available for OSM enrichment.",
			},
			providerErrors: [],
			cache,
		};
	}
	const eligible = matches.filter(
		(match) =>
			match.status === "matched" &&
			(match.confidence === "high" || match.confidence === "medium"),
	).length;
	if (eligible === 0) {
		return {
			matches,
			availability: {
				status: "unavailable",
				source: options.url ?? OVERPASS_PRIMARY,
				requestedItems: points.length,
				availableItems: 0,
				message:
					"No sufficiently confident road matches are available for OSM enrichment.",
			},
			providerErrors: [],
			cache,
		};
	}

	const data = await fetchOverpassBboxWays(routeBbox(points), options);

	if (data.ways === null) {
		return {
			matches,
			availability: {
				status: "unavailable",
				source: data.source,
				requestedItems: points.length,
				availableItems: 0,
				message: "All Overpass queries failed.",
			},
			providerErrors: data.errors,
			cache: data.cache,
			cacheError: data.cacheError,
		};
	}

	const enriched = enrichMatches(points, matches, data.ways, data.source);
	const availableItems = enriched.filter((m) => m.status === "matched").length;
	const status =
		data.completedChunks < data.totalChunks
			? availableItems > 0
				? "partial"
				: "unavailable"
			: availableItems === points.length
				? "complete"
				: availableItems > 0
					? "partial"
					: "unavailable";

	const availability: DataSourceAvailability = {
		status,
		source: data.source,
		requestedItems: points.length,
		availableItems,
		message:
			availableItems === points.length
				? undefined
				: `${points.length - availableItems} route point(s) were not matched to complete OSM road data.`,
	};

	return {
		matches: enriched,
		availability,
		providerErrors: data.errors,
		cache: data.cache,
		cacheError: data.cacheError,
	};
}

export const osmCacheTtlMilliseconds = OVERPASS_TTL_MS;
