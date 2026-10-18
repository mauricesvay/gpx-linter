import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	AMBIGUITY_GAP_METERS,
	BBOX_PADDING_DEGREES,
	DEFAULT_CACHE_DIR,
	GRID_CELL_DEGREES,
	HIGHWAY_PRIORITY,
	MAX_CHUNK_DEGREES,
	MAX_SNAP_DISTANCE_METERS,
	OSM_CACHE_FILE_NAME,
	OVERPASS_FALLBACK,
	OVERPASS_PRIMARY,
	OVERPASS_TIMEOUT_MS,
	OVERPASS_TTL_MS,
} from "../constants";
import type {
	CacheStats,
	DataSourceAvailability,
	MatchResult,
	Trackpoint,
} from "../types";

// Re-export constants so existing imports from cache.ts still work.
export {
	AMBIGUITY_GAP_METERS,
	BBOX_PADDING_DEGREES,
	DEFAULT_CACHE_DIR,
	GRID_CELL_DEGREES,
	HIGHWAY_PRIORITY,
	MAX_CHUNK_DEGREES,
	MAX_SNAP_DISTANCE_METERS,
	OSM_CACHE_FILE_NAME,
	OVERPASS_FALLBACK,
	OVERPASS_PRIMARY,
	OVERPASS_TIMEOUT_MS,
	OVERPASS_TTL_MS,
};

import { isRecord } from "../utils";

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

/** Current cache payload version. Bump when the serialized shape changes. */
export const CACHE_VERSION = "1";

export interface OsmCacheEntry {
	version: typeof CACHE_VERSION;
	source: string;
	storedAt: number;
	ways: OsmWay[];
	provider: string;
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
	osmWays?: OsmWay[];
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
			const latMin = Math.max(-90, bbox.latMin + (row * latSpan) / rows);
			const latMax = Math.min(
				90,
				row === rows - 1
					? bbox.latMax
					: bbox.latMin + ((row + 1) * latSpan) / rows,
			);
			const lonMin = Math.max(-180, bbox.lonMin + (col * lonSpan) / cols);
			const lonMax = Math.min(
				180,
				col === cols - 1
					? bbox.lonMax
					: bbox.lonMin + ((col + 1) * lonSpan) / cols,
			);
			chunks.push({ latMin, lonMin, latMax, lonMax });
		}
	}
	return chunks;
}

function bboxString(b: OsmBbox): string {
	return `${b.latMin},${b.lonMin},${b.latMax},${b.lonMax}`;
}

// Snap chunk bbox to a fixed grid so different routes covering the same area
// produce the same cache key. Grid is 0.2° (~22km) matching MAX_CHUNK_DEGREES.
export function bboxKeyString(b: OsmBbox): string {
	const grid = MAX_CHUNK_DEGREES;
	return [
		(Math.floor(b.latMin / grid) * grid).toFixed(4),
		(Math.floor(b.lonMin / grid) * grid).toFixed(4),
		(Math.floor(b.latMax / grid) * grid).toFixed(4),
		(Math.floor(b.lonMax / grid) * grid).toFixed(4),
	].join(",");
}

export function bboxKey(bbox: OsmBbox): string {
	return createHash("sha256")
		.update(`bbox|${bboxKeyString(bbox)}`)
		.digest("hex");
}

export function bboxQuery(bbox: OsmBbox): string {
	return `[out:json][timeout:25];way(${bboxString(bbox)})["highway"];out body geom;`;
}

/* ── cache helpers (reuse old format) ────────────────────────────────── */

/** Validate and normalize a cache entry, rejecting stale versions. */
function normalizeOsmCacheEntry(
	key: string,
	value: unknown,
): OsmCacheEntry | null {
	if (!isRecord(value)) return null;
	const v = value as Record<string, unknown>;

	// Reject entries without a version field (old format).
	if (v.version !== CACHE_VERSION) {
		console.warn(
			`Cache entry "${key}" has version "${String(v.version)}"; expected "${CACHE_VERSION}". Discarding.`,
		);
		return null;
	}

	if (
		typeof v.storedAt !== "number" ||
		!Number.isFinite(v.storedAt) ||
		typeof v.source !== "string" ||
		typeof v.provider !== "string" ||
		!Array.isArray(v.ways) ||
		!v.ways.every(isOsmWay)
	) {
		return null;
	}

	return {
		version: CACHE_VERSION,
		source: v.source,
		storedAt: v.storedAt,
		provider: v.provider,
		ways: v.ways,
	};
}

export async function readOsmCache(
	cachePath: string,
): Promise<Record<string, OsmCacheEntry>> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		if (!isRecord(parsed)) throw new Error("cache file root is not an object");
		const entries: Record<string, OsmCacheEntry> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const normalized = normalizeOsmCacheEntry(key, value);
			if (normalized) {
				entries[key] = normalized;
			}
		}
		return entries;
	} catch (error) {
		if (isRecord(error) && (error as Record<string, string>).code === "ENOENT")
			return {};
		throw error;
	}
}

export function isOsmWay(value: unknown): value is OsmWay {
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
