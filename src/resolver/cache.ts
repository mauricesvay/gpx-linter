import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
	CACHE_FILE_NAME,
	DEFAULT_CACHE_DIR,
	ROAD_CACHE_TTL_MS,
} from "../constants";
import { isRecord } from "../utils";
export const CACHE_VERSION = "1";
// Re-export for backwards compatibility.
export { DEFAULT_CACHE_DIR };

import type { MatchResult, Trackpoint } from "../types";

interface CacheEntry {
	version: typeof CACHE_VERSION;
	storedAt: number;
	result: MatchResult;
}

export { CACHE_FILE_NAME, type CacheEntry, ROAD_CACHE_TTL_MS };

const QUANTIZE_DP = 5; // ~1 meter precision

/** Quantize lat/lon to 5 decimal places (~1 m) so re-rides of same route hit cache. */
function quantizePoint(point: Trackpoint): string {
	return `${point.lat.toFixed(QUANTIZE_DP)},${point.lon.toFixed(QUANTIZE_DP)}`;
}

export function cacheKey(point: Trackpoint): string {
	return createHash("sha256").update(quantizePoint(point)).digest("hex");
}

export function isUsableCacheEntry(result: unknown): result is MatchResult {
	const entry = isRecord(result) ? result : null;
	return (
		entry !== null &&
		entry.status === "matched" &&
		(entry.confidence === "high" || entry.confidence === "medium") &&
		typeof entry.score === "number"
	);
}

/** Check if a cache entry has expired past its TTL. */
export function isExpired(entry: CacheEntry, ttlMs: number): boolean {
	return Date.now() - entry.storedAt >= ttlMs;
}

export function makeCacheEntry(
	_point: Trackpoint,
	result: MatchResult,
): CacheEntry {
	return { version: CACHE_VERSION, storedAt: Date.now(), result };
}

function normalizeCacheEntry(key: string, value: unknown): CacheEntry | null {
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
		!isUsableCacheEntry(v.result)
	) {
		return null;
	}

	return {
		version: CACHE_VERSION,
		storedAt: v.storedAt,
		result: v.result as MatchResult,
	};
}

/** Maximum number of entries to keep in the road cache. */
const MAX_CACHE_ENTRIES = 100_000;

/** Evict expired entries and cap by count (LRU by storedAt). Returns cleaned cache. */
export function compactCache(
	cache: Record<string, CacheEntry>,
): Record<string, CacheEntry> {
	const _now = Date.now();
	const compacted: Record<string, CacheEntry> = {};
	let expired = 0;

	// Remove expired entries.
	for (const [key, entry] of Object.entries(cache)) {
		if (isExpired(entry, ROAD_CACHE_TTL_MS)) {
			expired++;
		} else {
			compacted[key] = entry;
		}
	}

	// Cap by count: evict oldest entries (by storedAt) until within limit.
	if (Object.keys(compacted).length > MAX_CACHE_ENTRIES) {
		const sorted = Object.entries(compacted).sort(
			(a, b) => a[1].storedAt - b[1].storedAt,
		);
		const toKeep = sorted.slice(0, MAX_CACHE_ENTRIES);
		for (const [key, entry] of toKeep) {
			compacted[key] = entry;
		}
		const evicted = sorted.length - toKeep.length;
		if (evicted > 0) {
			console.warn(
				`Road cache capped: evicted ${evicted} oldest entries (max ${MAX_CACHE_ENTRIES}).`,
			);
		}
	}

	if (expired > 0) {
		console.warn(`Road cache compacted: removed ${expired} expired entries.`);
	}

	return compacted;
}

export async function readCache(
	cachePath: string,
): Promise<Record<string, CacheEntry>> {
	try {
		const raw = await readFile(cachePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) throw new Error("cache file root is not an object");
		const entries: Record<string, CacheEntry> = {};
		for (const [key, value] of Object.entries(parsed)) {
			const normalized = normalizeCacheEntry(key, value);
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
