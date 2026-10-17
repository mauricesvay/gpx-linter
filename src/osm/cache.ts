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

/* ── constants ──────────────────────────────────────────────────────── */

export const OVERPASS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OVERPASS_TIMEOUT_MS = 25_000;
export const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
export const OVERPASS_FALLBACK = "https://overpass.kumi.systems/api/interpreter";
export const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "gpxlint");
export const OSM_CACHE_FILE_NAME = "osm-cache.json";
export const MAX_CHUNK_DEGREES = 0.2;
export const BBOX_PADDING_DEGREES = 0.005;
export const GRID_CELL_DEGREES = 0.02;
export const MAX_SNAP_DISTANCE_METERS = 100;
export const AMBIGUITY_GAP_METERS = 15;
export const HIGHWAY_PRIORITY: Record<string, number> = {
	motorway: 7,
	trunk: 6,
	primary: 5,
	secondary: 4,
	tertiary: 3,
	residential: 2,
	unclassified: 2,
	service: 1,
	pedestrian: 1,
};

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

export interface OsmCacheEntry {
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

export function bboxKey(bbox: OsmBbox): string {
	return createHash("sha256")
		.update(`bbox|${bboxString(bbox)}`)
		.digest("hex");
}

export function bboxQuery(bbox: OsmBbox): string {
	return `[out:json][timeout:25];way(${bboxString(bbox)})["highway"];out body geom;`;
}

/* ── cache helpers (reuse old format) ────────────────────────────────── */

export async function readOsmCache(
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
