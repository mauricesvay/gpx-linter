import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchOverpassBboxWays, routeBbox, snapPointsToWays } from "./osm";
import type {
	CacheStats,
	DataSourceAvailability,
	MatchResult,
	Trackpoint,
} from "./types";
import { isRecord, message, truncateText } from "./utils";

const ROAD_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "gpxlint");
const CACHE_FILE_NAME = "cache.json";

interface CacheEntry {
	storedAt: number;
	result: MatchResult;
}

export interface ResolutionResult {
	matches: MatchResult[];
	availability: DataSourceAvailability;
	cache: CacheStats;
	providerErrors: string[];
	cacheError?: string;
}

export async function resolveRoads(
	points: Trackpoint[],
	options: {
		provider?: "overpass" | "offline";
		url?: string;
		overpassUrl?: string;
		cache?: boolean;
		cacheDir?: string;
		fetcher?: typeof fetch;
	} = {},
): Promise<ResolutionResult> {
	const cacheStats = { hits: 0, misses: 0 };
	const errors: string[] = [];
	const cacheEnabled = options.cache !== false;
	const cachePath = path.join(
		options.cacheDir ?? DEFAULT_CACHE_DIR,
		CACHE_FILE_NAME,
	);
	let cache: Record<string, CacheEntry> = {};
	let cacheError: string | undefined;
	if (cacheEnabled) {
		try {
			cache = await readCache(cachePath);
		} catch (error) {
			cacheError = `Unable to read road cache: ${message(error)}`;
		}
	}

	const now = Date.now();
	const matches: (MatchResult | undefined)[] = new Array(points.length);
	const misses: Trackpoint[] = [];
	const missIndexes: number[] = [];
	for (let i = 0; i < points.length; i++) {
		const key = cacheKey(points[i]);
		const entry = cache[key];
		if (
			cacheEnabled &&
			entry &&
			now - entry.storedAt >= 0 &&
			now - entry.storedAt < ROAD_CACHE_TTL_MS &&
			isUsableCacheEntry(entry.result)
		) {
			matches[i] = {
				...entry.result,
				provider: entry.result.provider ?? "cache",
			};
			cacheStats.hits++;
		} else {
			misses.push(points[i]);
			missIndexes.push(i);
			if (cacheEnabled) cacheStats.misses++;
		}
	}

	if (misses.length === 0) {
		return buildResult(
			matches as MatchResult[],
			cacheStats,
			errors,
			cacheError,
			options.provider ?? "overpass",
		);
	}

	const provider = options.provider ?? "overpass";
	if (provider === "overpass") {
		const resolved = await resolveWithOverpass(misses, {
			overpassUrl: options.overpassUrl ?? options.url,
			cache: options.cache,
			cacheDir: options.cacheDir,
			fetcher: options.fetcher,
		});
		if (resolved.error) errors.push(`overpass: ${resolved.error}`);
		if (resolved.results) {
			resolved.results.forEach((match, index) => {
				matches[missIndexes[index]] = match;
				if (cacheEnabled && isUsableCacheEntry(match)) {
					cache[cacheKey(misses[index])] = { storedAt: now, result: match };
				}
			});
		}
	} else {
		errors.push("offline: No offline road-matching backend is configured.");
	}

	const finalMatches: MatchResult[] = Array.from(
		matches,
		(match) =>
			match ?? {
				status: "unmatched",
				confidence: "unknown",
				score: 0,
				reason:
					"No usable match was returned by the configured routing provider.",
				provider,
			},
	);
	if (cacheEnabled && cacheStats.misses > 0) {
		try {
			await mkdir(path.dirname(cachePath), { recursive: true });
			await writeFile(cachePath, JSON.stringify(cache), "utf8");
		} catch (error) {
			cacheError = `Unable to write road cache: ${message(error)}`;
		}
	}
	return buildResult(finalMatches, cacheStats, errors, cacheError, provider);
}

/* ── provider ───────────────────────────────────────────────────────── */

async function resolveWithOverpass(
	points: Trackpoint[],
	options: {
		overpassUrl?: string;
		cache?: boolean;
		cacheDir?: string;
		fetcher?: typeof fetch;
	},
): Promise<{ results: MatchResult[] | null; error?: string }> {
	const bbox = routeBbox(points);
	const data = await fetchOverpassBboxWays(bbox, {
		url: options.overpassUrl,
		fetcher: options.fetcher,
		cache: options.cache,
		cacheDir: options.cacheDir,
	});
	if (data.ways === null) {
		return {
			results: null,
			error: data.errors.join("; ") || "All Overpass queries failed.",
		};
	}
	const results = snapPointsToWays(points, data.ways, "overpass");
	const failed = data.totalChunks - data.completedChunks;
	if (failed > 0) {
		return {
			results,
			error: truncateText(
				`${failed} of ${data.totalChunks} Overpass chunks failed; nearby points may be unmatched. ${data.errors.slice(0, 3).join("; ")}`,
				200,
			),
		};
	}
	return { results };
}

/* ── cache ──────────────────────────────────────────────────────────── */

function isUsableCacheEntry(result: unknown): result is MatchResult {
	const entry = isRecord(result) ? result : null;
	return (
		entry !== null &&
		entry.status === "matched" &&
		(entry.confidence === "high" || entry.confidence === "medium") &&
		typeof entry.score === "number"
	);
}

function cacheKey(point: Trackpoint): string {
	return createHash("sha256").update(`${point.lat},${point.lon}`).digest("hex");
}

async function readCache(
	cachePath: string,
): Promise<Record<string, CacheEntry>> {
	try {
		const raw = await readFile(cachePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) throw new Error("cache file root is not an object");
		const entries: Record<string, CacheEntry> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (
				!isRecord(value) ||
				typeof value.storedAt !== "number" ||
				!Number.isFinite(value.storedAt) ||
				!isUsableCacheEntry(value.result)
			) {
				throw new Error(`invalid cache entry "${key}"`);
			}
			entries[key] = { storedAt: value.storedAt, result: value.result };
		}
		return entries;
	} catch (error) {
		if (isRecord(error) && (error as Record<string, string>).code === "ENOENT")
			return {};
		throw error;
	}
}

function buildResult(
	finalMatches: MatchResult[],
	cacheStats: CacheStats,
	errors: string[],
	cacheError: string | undefined,
	provider: string,
): ResolutionResult {
	const availableItems = finalMatches.filter(
		(match) => match.status === "matched",
	).length;
	const unknownItems = finalMatches.filter(
		(match) =>
			match.status !== "matched" ||
			match.confidence === "low" ||
			match.confidence === "unknown",
	).length;
	const availability: DataSourceAvailability = {
		status:
			finalMatches.length === 0 || availableItems === 0
				? "unavailable"
				: unknownItems > 0
					? "partial"
					: "complete",
		source: provider,
		requestedItems: finalMatches.length,
		availableItems,
	};
	if (errors.length > 0) availability.message = errors.join("; ");
	else if (unknownItems > 0)
		availability.message = `${unknownItems} trackpoint(s) could not be matched with sufficient confidence.`;
	return {
		matches: finalMatches,
		availability,
		cache: cacheStats,
		providerErrors: errors,
		cacheError,
	};
}
