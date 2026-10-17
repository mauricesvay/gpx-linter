import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bearingDegrees, pointToGeometryDistanceMeters } from "./geo";
import type {
	CacheStats,
	DataSourceAvailability,
	MatchResult,
	Trackpoint,
} from "./types";
import {
	confidenceFromScore,
	delay,
	errorMessage,
	isRecord,
	retryAfterMilliseconds,
	responseBodyDetail,
	truncateText,
} from "./utils";

/* ── constants ──────────────────────────────────────────────────────── */

const OVERPASS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OVERPASS_TIMEOUT_MS = 25_000;
const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK = "https://overpass.kumi.systems/api/interpreter";
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "gpxlint");
const OSM_CACHE_FILE_NAME = "osm-cache.json";
const MAX_CHUNK_DEGREES = 0.2;
const BBOX_PADDING_DEGREES = 0.005;
const GRID_CELL_DEGREES = 0.02;
export const MAX_SNAP_DISTANCE_METERS = 100;
const AMBIGUITY_GAP_METERS = 2;

/* ── public types ───────────────────────────────────────────────────── */

export interface OsmWay {
	id: number;
	tags: Record<string, string>;
	geometry: { lat: number; lon: number }[];
}

export interface OsmBbox {
	latMin: number;
	lonMin: number;
	latMax: number;
	lonMax: number;
}

interface OsmCacheEntry {
	ways: OsmWay[];
	provider: string;
	fetchedAt: number;
}

export interface OsmDataOptions {
	url?: string;
	fetcher?: typeof fetch;
	cache?: boolean;
	cacheDir?: string;
}

export interface OsmData {
	ways: OsmWay[] | null;
	completedChunks: number;
	totalChunks: number;
	errors: string[];
	cache: CacheStats;
	cacheError?: string;
	source: string;
}

export interface OsmEnrichmentResult {
	matches: MatchResult[];
	availability: DataSourceAvailability;
	providerErrors: string[];
	cache: CacheStats;
	cacheError?: string;
}

/* ── bbox helpers ────────────────────────────────────────────────────── */

export function routeBbox(points: Trackpoint[]): OsmBbox {
	const padding = BBOX_PADDING_DEGREES;
	let latMin = 90,
		lonMin = 180,
		latMax = -90,
		lonMax = -180;
	for (const point of points) {
		latMin = Math.min(latMin, point.lat);
		lonMin = Math.min(lonMin, point.lon);
		latMax = Math.max(latMax, point.lat);
		lonMax = Math.max(lonMax, point.lon);
	}
	return {
		latMin: Math.max(-90, latMin - padding),
		lonMin: Math.max(-180, lonMin - padding),
		latMax: Math.min(90, latMax + padding),
		lonMax: Math.min(180, lonMax + padding),
	};
}

export function chunkBbox(bbox: OsmBbox): OsmBbox[] {
	const chunks: OsmBbox[] = [];
	const latSpan = bbox.latMax - bbox.latMin;
	const lonSpan = bbox.lonMax - bbox.lonMin;
	const rows = Math.max(1, Math.ceil(latSpan / MAX_CHUNK_DEGREES));
	const cols = Math.max(1, Math.ceil(lonSpan / MAX_CHUNK_DEGREES));
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const latMin = Math.max(
				-90,
				bbox.latMin + (row * latSpan) / rows,
			);
			const latMax = Math.min(
				90,
				row === rows - 1 ? bbox.latMax : bbox.latMin + ((row + 1) * latSpan) / rows,
			);
			const lonMin = Math.max(
				-180,
				bbox.lonMin + (col * lonSpan) / cols,
			);
			const lonMax = Math.min(
				180,
				col === cols - 1 ? bbox.lonMax : bbox.lonMin + ((col + 1) * lonSpan) / cols,
			);
			chunks.push({ latMin, lonMin, latMax, lonMax });
		}
	}
	return chunks;
}

function bboxString(b: OsmBbox): string {
	return `${b.latMin},${b.lonMin},${b.latMax},${b.lonMax}`;
}

function bboxKey(bbox: OsmBbox): string {
	return createHash("sha256")
		.update(`bbox|${bboxString(bbox)}`)
		.digest("hex");
}

function bboxQuery(bbox: OsmBbox): string {
	return `[out:json][timeout:25];way(${bboxString(bbox)})["highway"];out body geom;`;
}

/* ── cache helpers (reuse old format) ────────────────────────────────── */

async function readOsmCache(
	cachePath: string,
): Promise<Record<string, OsmCacheEntry>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		if (!isRecord(parsed)) throw new Error("cache file root is not an object");
		const entries: Record<string, OsmCacheEntry> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (
				!isRecord(value) ||
				typeof value.provider !== "string" ||
				typeof value.fetchedAt !== "number" ||
				!Number.isFinite(value.fetchedAt) ||
				!Array.isArray(value.ways) ||
				!value.ways.every(isOsmWay)
			) {
				throw new Error(`invalid OSM cache entry "${key}"`);
			}
			entries[key] = {
				provider: value.provider,
				fetchedAt: value.fetchedAt,
				ways: value.ways,
			};
		}
		return entries;
	} catch (error) {
		if (isRecord(error) && (error as Record<string, string>).code === "ENOENT")
			return {};
		throw error;
	}
}

function isOsmWay(value: unknown): value is OsmWay {
	if (
		!isRecord(value) ||
		typeof value.id !== "number" ||
		!Number.isSafeInteger(value.id) ||
		!isRecord(value.tags) ||
		!Array.isArray(value.geometry) ||
		value.geometry.length < 2
	)
		return false;
	return (
		Object.values(value.tags).every((tag) => typeof tag === "string") &&
		value.geometry.every(
			(position) =>
				isRecord(position) &&
				typeof position.lat === "number" &&
				Number.isFinite(position.lat) &&
				typeof position.lon === "number" &&
				Number.isFinite(position.lon),
		)
	);
}

/* ── Overpass fetch (chunked bbox) ──────────────────────────────────── */

async function requestOverpass(
	url: string,
	query: string,
	fetcher: typeof fetch,
): Promise<{ text: string; error?: string }> {
	let lastError = "Request failed.";
	for (let attempt = 0; attempt < 2; attempt++) {
		let response: Response;
		try {
			response = await fetcher(url, {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"User-Agent": "gpxlint/1.0.0",
				},
				body: `data=${encodeURIComponent(query)}`,
				signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
			});
		} catch (error) {
			lastError = errorMessage(error);
			if (attempt === 0) {
				await delay(1000);
				continue;
			}
			return { text: "", error: lastError };
		}
		if (response.ok) {
			try {
				return { text: await response.text() };
			} catch (error) {
				return {
					text: "",
					error: `Unable to read Overpass response: ${errorMessage(error)}`,
				};
			}
		}
		let body = "";
		try {
			body = await response.text();
		} catch {
			// Body unreadable; keep the status-only error.
		}
		lastError =
			`HTTP ${response.status} ${response.statusText}`.trim() + responseBodyDetail(body);
		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt > 0) return { text: "", error: lastError };
		const delayMs = retryAfterMilliseconds(response.headers.get("retry-after"));
		if (delayMs === null) return { text: "", error: lastError };
		await delay(delayMs);
	}
	return { text: "", error: lastError };
}

function parseWays(text: string): OsmWay[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.elements)) return null;
	const ways: OsmWay[] = [];
	for (const element of parsed.elements) {
		if (!isRecord(element)) return null;
		if (element.type !== "way") continue;
		if (
			typeof element.id !== "number" ||
			!Number.isSafeInteger(element.id) ||
			!isRecord(element.tags) ||
			!Array.isArray(element.geometry)
		)
			return null;
		const geometry: OsmWay["geometry"] = [];
		for (const position of element.geometry) {
			if (
				!isRecord(position) ||
				typeof position.lat !== "number" ||
				!Number.isFinite(position.lat) ||
				typeof position.lon !== "number" ||
				!Number.isFinite(position.lon)
			)
				return null;
			geometry.push({ lat: position.lat, lon: position.lon });
		}
		if (geometry.length < 2) return null;
		const tags: Record<string, string> = {};
		for (const [key, value] of Object.entries(element.tags)) {
			if (typeof value !== "string") return null;
			tags[key] = value;
		}
		ways.push({ id: element.id, tags, geometry });
	}
	return ways;
}

export async function fetchOverpassBboxWays(
	bbox: OsmBbox,
	options: OsmDataOptions = {},
): Promise<OsmData> {
	const cache = { hits: 0, misses: 0 };
	let cacheError: string | undefined;
	const cacheEnabled = options.cache !== false;
	const cachePath = path.join(
		options.cacheDir ?? DEFAULT_CACHE_DIR,
		OSM_CACHE_FILE_NAME,
	);
	const cacheKey = (b: OsmBbox) => bboxKey(b);
	let entries: Record<string, OsmCacheEntry> = {};
	if (cacheEnabled) {
		try {
			entries = await readOsmCache(cachePath);
		} catch (error) {
			cacheError = `Unable to read OSM cache: ${errorMessage(error)}`;
		}
	}
	const urls = options.url ? [options.url] : [OVERPASS_PRIMARY, OVERPASS_FALLBACK];
	const fetcher = options.fetcher ?? fetch;
	const chunks = chunkBbox(bbox);
	const waysById = new Map<number, OsmWay>();
	const providedBy = new Set<string>();
	const completedChunks: number[] = [];
	const errors: string[] = [];
	const fetchedEntries: Record<string, OsmCacheEntry> = {};
	let lastRequestAt = 0;

	for (const chunk of chunks) {
		const key = cacheKey(chunk);
		const cached = cacheEnabled ? entries[key] : undefined;
		if (
			cached &&
			Date.now() - cached.fetchedAt < OVERPASS_TTL_MS
		) {
			for (const way of cached.ways) waysById.set(way.id, way);
			providedBy.add(cached.provider);
			completedChunks.push(1);
			cache.hits++;
			continue;
		}
		if (cacheEnabled) cache.misses++;
		let chunkWays: OsmWay[] | null = null;
		let supplier: string | null = null;
		for (const url of urls) {
			const rateLimitWait = 1000 - (Date.now() - lastRequestAt);
			if (lastRequestAt > 0 && rateLimitWait > 0) await delay(rateLimitWait);
			lastRequestAt = Date.now();
			const response = await requestOverpass(url, bboxQuery(chunk), fetcher);
			lastRequestAt = Date.now();
			if (response.error) {
				errors.push(`${url}: ${response.error}`);
				continue;
			}
			const parsed = parseWays(response.text);
			if (!parsed) {
				errors.push(
					`${url}: Overpass returned malformed or unusable data.${responseBodyDetail(response.text)}`,
				);
				continue;
			}
			chunkWays = parsed;
			supplier = url;
			break;
		}
		if (chunkWays !== null && supplier !== null) {
			completedChunks.push(1);
			providedBy.add(supplier);
			for (const way of chunkWays) waysById.set(way.id, way);
			fetchedEntries[key] = {
				ways: chunkWays,
				provider: supplier,
				fetchedAt: Date.now(),
			};
		}
	}

	let ways: OsmWay[] | null = null;
	if (completedChunks.length > 0) ways = Array.from(waysById.values());

	if (Object.keys(fetchedEntries).length > 0 && cacheEnabled) {
		Object.assign(entries, fetchedEntries);
		try {
			await mkdir(path.dirname(cachePath), { recursive: true });
			await writeFile(cachePath, JSON.stringify(entries), "utf8");
		} catch (error) {
			cacheError = `Unable to write OSM cache: ${errorMessage(error)}`;
		}
	}

	const totalChunks = chunks.length;
	return {
		ways,
		completedChunks: completedChunks.length,
		totalChunks,
		errors,
		cache,
		cacheError,
		source: [...providedBy].join(", ") || urls.join(", "),
	};
}

/* ── local snapping ──────────────────────────────────────────────────── */

interface IndexedWay {
	way: OsmWay;
	coordinates: [number, number][];
	latMin: number;
	lonMin: number;
	latMax: number;
	lonMax: number;
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

	return points.map((point, index) => {
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
		const candidates: {
			way: OsmWay;
			distance: number;
		}[] = [];
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
				candidates.push({ way: entry.way, distance });
			}
		}

		if (candidates.length === 0) {
			return {
				status: "unmatched",
				confidence: "unknown",
				score: 0,
				reason: `No OSM road geometry was found within ${MAX_SNAP_DISTANCE_METERS}m of the trackpoint.`,
				provider,
			};
		}

		candidates.sort((a, b) => a.distance - b.distance);
		const nearest = candidates[0];
		const routeBearing = getRouteBearing(points, index);
		const score = Math.max(0, 1 - nearest.distance / MAX_SNAP_DISTANCE_METERS);
		const confidence = confidenceFromScore(score);
		const direction =
			routeBearing === undefined
				? "unknown"
				: resolveDirection(point, routeBearing, nearest.way.geometry);

		const ambiguous =
			candidates.length > 1 &&
			candidates[1].distance - candidates[0].distance <= AMBIGUITY_GAP_METERS;

		if (ambiguous) {
			return {
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
					score: Math.max(0, 1 - c.distance / 30),
					highway: c.way.tags.highway,
					distanceToRoad: c.distance,
				})),
			};
		}

		return {
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
		};
	});
}

/* ── enrichment (backward-compatible, uses chunked fetch) ────────────── */

function enrichMatches(
	points: Trackpoint[],
	matches: MatchResult[],
	ways: OsmWay[],
	suppliedBy: string,
): MatchResult[] {
	const { cells, indexed } = buildWayIndex(ways);
	return matches.map((match, index) => {
		if (
			match.status !== "matched" ||
			match.confidence === "low" ||
			match.confidence === "unknown"
		)
			return match;
		const point = points[index];
		const cellX = Math.floor(point.lon / GRID_CELL_DEGREES);
		const cellY = Math.floor(point.lat / GRID_CELL_DEGREES);
		const latDeg = MAX_SNAP_DISTANCE_METERS / 111_320;
		const lonDeg =
			MAX_SNAP_DISTANCE_METERS /
			(111_320 * Math.cos((point.lat * Math.PI) / 180));
		const seen = new Set<number>();
		const candidates: { way: OsmWay; distance: number }[] = [];
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
					if (distance <= MAX_SNAP_DISTANCE_METERS)
						candidates.push({ way: entry.way, distance });
				}
			}
		}
		if (candidates.length === 0) {
			return {
				...match,
				status: "unmatched",
				confidence: "unknown",
				reason:
					`No OSM road geometry was found within ${MAX_SNAP_DISTANCE_METERS}m of the matched point.`,
				candidates: [],
			};
		}
		candidates.sort((a, b) => a.distance - b.distance);
		const ambiguous =
			candidates.length > 1 &&
			candidates[1].distance - candidates[0].distance <= AMBIGUITY_GAP_METERS;
		const selected = candidates[0];
		if (ambiguous) {
			return {
				...match,
				status: "ambiguous",
				confidence: "low",
				reason: "Multiple nearby OSM roads have similarly plausible distances.",
				candidates: candidates.slice(0, 5).map((candidate) => ({
					roadId: String(candidate.way.id),
					score: Math.max(0, 1 - candidate.distance / MAX_SNAP_DISTANCE_METERS),
					highway: candidate.way.tags.highway,
					distanceToRoad: candidate.distance,
				})),
			};
		}
		const routeBearing = getRouteBearing(points, index);
		const wayDirection =
			routeBearing === undefined
				? "unknown"
				: resolveDirection(
						points[index],
						routeBearing,
						selected.way.geometry,
					);
		return {
			...match,
			roadId: String(selected.way.id),
			roadName: selected.way.tags.name,
			osmDistanceToRoad: selected.distance,
			tags: selected.way.tags,
			direction: wayDirection,
			provider: match.provider,
		};
	});
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
