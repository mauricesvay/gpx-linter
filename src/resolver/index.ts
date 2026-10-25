import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchOverpassBboxWays, type OsmWay, routeBbox } from "../osm";
import type {
	CacheStats,
	DataSourceAvailability,
	MatchResult,
	Trackpoint,
} from "../types";
import { message } from "../utils";
import {
	CACHE_VERSION,
	type CacheEntry,
	cacheKey,
	compactCache,
	DEFAULT_CACHE_DIR,
	isUsableCacheEntry,
	ROAD_CACHE_TTL_MS,
	readCache,
} from "./cache";
import { resolveWithOverpass } from "./overpass";

export interface ResolutionResult {
	matches: MatchResult[];
	ambiguousMatches?: MatchResult[];
	osmWays?: OsmWay[];
	osmWaysAvailability?: DataSourceAvailability;
	osmWaysErrors?: string[];
	osmWaysCache?: CacheStats;
	osmWaysCacheError?: string;
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
		pbfPath?: string;
		cache?: boolean;
		cacheDir?: string;
		fetcher?: typeof fetch;
		/** When true, also fetch OSM way geometry for rules needing full way data. */
		fetchOsmWays?: boolean;
	} = {},
): Promise<ResolutionResult> {
	const cacheStats = { hits: 0, misses: 0 };
	const errors: string[] = [];
	const cacheEnabled = options.cache !== false;
	const cachePath = path.join(
		options.cacheDir ?? DEFAULT_CACHE_DIR,
		"cache.json",
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
	let osmWays: OsmWay[] | undefined;
	let osmWaysAvailability: DataSourceAvailability | undefined;
	let osmWaysErrors: string[] = [];
	let osmWaysCache: CacheStats | undefined;
	let osmWaysCacheError: string | undefined;
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
		const provider = options.provider ?? "overpass";
		if (provider === "overpass" && options.fetchOsmWays) {
			const data = await fetchOverpassBboxWays(routeBbox(points), {
				url: options.overpassUrl ?? options.url,
				cache: options.cache,
				cacheDir: options.cacheDir,
				fetcher: options.fetcher,
			});
			osmWays = data.ways ?? [];
			osmWaysAvailability = getOsmWaysAvailability(data);
			osmWaysErrors = data.errors;
			osmWaysCache = data.cache;
			osmWaysCacheError = data.cacheError;
		}
	} else {
		const provider = options.provider ?? "overpass";
		if (provider === "overpass") {
			const pointsToResolve = options.fetchOsmWays ? points : misses;
			const indexesToResolve = options.fetchOsmWays
				? points.map((_, index) => index)
				: missIndexes;
			const resolved = await resolveWithOverpass(pointsToResolve, {
				overpassUrl: options.overpassUrl ?? options.url,
				cache: options.cache,
				cacheDir: options.cacheDir,
				fetcher: options.fetcher,
				fetchOsmWays: options.fetchOsmWays,
			});
			if (resolved.error) errors.push(`overpass: ${resolved.error}`);
			osmWays = resolved.osmWays;
			osmWaysAvailability = resolved.osmWaysAvailability;
			osmWaysErrors = resolved.osmWaysErrors ?? [];
			osmWaysCache = resolved.osmWaysCache;
			osmWaysCacheError = resolved.osmWaysCacheError;
			if (resolved.results) {
				resolved.results.forEach((match, index) => {
					const pointIndex = indexesToResolve[index];
					if (!options.fetchOsmWays || matches[pointIndex] === undefined) {
						matches[pointIndex] = match;
					}
					if (cacheEnabled && isUsableCacheEntry(match)) {
						cache[cacheKey(pointsToResolve[index])] = {
							version: CACHE_VERSION,
							storedAt: now,
							result: match,
						};
					}
				});
			}
		} else {
			// Offline mode: use PBF file if provided.
			if (options.pbfPath) {
				const data = await fetchOverpassBboxWays(routeBbox(points), {
					pbfPath: options.pbfPath,
					cache: options.cache,
					cacheDir: options.cacheDir,
				});
				if (data.ways === null) {
					errors.push(
						`PBF: ${data.errors.join("; ") || "No highway ways found."}`,
					);
				}
				osmWays = data.ways ?? [];
				osmWaysAvailability = getOsmWaysAvailability(data);
				osmWaysErrors = data.errors;
			} else {
				errors.push("offline: No PBF file provided. Use --pbf <path>.");
			}
		}
	}

	const provider = options.provider ?? "overpass";
	// P0-3: Keep ambiguous results instead of filtering them out.
	const finalMatches: MatchResult[] = Array.from(
		matches,
		(match) =>
			match ?? {
				status: "unmatched" as const,
				confidence: "unknown" as const,
				score: 0,
				reason:
					"No usable match was returned by the configured routing provider.",
				provider,
			},
	);
	// Extract ambiguous matches separately for diagnostic value.
	const ambiguousMatches: MatchResult[] = finalMatches.filter(
		(m) => m.status === "ambiguous",
	);
	if (cacheEnabled && cacheStats.misses > 0) {
		cacheError = await writeCache(cachePath, cache);
	}
	return buildResult(
		finalMatches,
		ambiguousMatches,
		cacheStats,
		errors,
		cacheError,
		provider,
		osmWays,
		osmWaysAvailability,
		osmWaysErrors,
		osmWaysCache,
		osmWaysCacheError,
	);
}

function getOsmWaysAvailability(
	data: Awaited<ReturnType<typeof fetchOverpassBboxWays>>,
): DataSourceAvailability {
	const status =
		data.completedChunks === data.totalChunks
			? "complete"
			: data.completedChunks > 0
				? "partial"
				: "unavailable";
	return {
		status,
		source: data.source,
		requestedItems: data.totalChunks,
		availableItems: data.completedChunks,
		message:
			status === "complete"
				? undefined
				: data.errors.join("; ") || "OSM way data is incomplete.",
	};
}

async function writeCache(
	cachePath: string,
	cache: Record<string, CacheEntry>,
): Promise<string | undefined> {
	try {
		const compacted = compactCache(cache);
		await mkdir(path.dirname(cachePath), { recursive: true });
		await writeFile(cachePath, JSON.stringify(compacted), "utf8");
	} catch (error) {
		return `Unable to write road cache: ${message(error)}`;
	}
	return undefined;
}

function buildResult(
	finalMatches: MatchResult[],
	ambiguousMatches: MatchResult[],
	cacheStats: CacheStats,
	errors: string[],
	cacheError: string | undefined,
	provider: string,
	osmWays: OsmWay[] | undefined,
	osmWaysAvailability?: DataSourceAvailability,
	osmWaysErrors: string[] = [],
	osmWaysCache?: CacheStats,
	osmWaysCacheError?: string,
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
		ambiguousMatches:
			ambiguousMatches.length > 0 ? ambiguousMatches : undefined,
		osmWays,
		osmWaysAvailability,
		osmWaysErrors,
		osmWaysCache,
		osmWaysCacheError,
		availability,
		cache: cacheStats,
		providerErrors: errors,
		cacheError,
	};
}
