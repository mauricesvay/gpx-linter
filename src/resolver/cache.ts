import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isRecord } from "../utils";
import {
	CACHE_FILE_NAME,
	DEFAULT_CACHE_DIR,
	ROAD_CACHE_TTL_MS,
} from "../constants";
export const CACHE_VERSION = "1";
// Re-export for backwards compatibility.
export { DEFAULT_CACHE_DIR };
import type { MatchResult, Trackpoint } from "../types";

interface CacheEntry {
	version: typeof CACHE_VERSION;
	storedAt: number;
	result: MatchResult;
}

export { ROAD_CACHE_TTL_MS, CACHE_FILE_NAME };

export function cacheKey(point: Trackpoint): string {
	return createHash("sha256").update(`${point.lat},${point.lon}`).digest("hex");
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

export function makeCacheEntry(
	point: Trackpoint,
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
