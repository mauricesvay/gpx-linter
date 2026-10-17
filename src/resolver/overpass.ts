import type { OsmWay } from "../osm";
import { fetchOverpassBboxWays, routeBbox, snapPointsToWays } from "../osm";
import type { DataSourceAvailability, MatchResult, Trackpoint } from "../types";
import { truncateText } from "../utils";

export async function resolveWithOverpass(
	points: Trackpoint[],
	options: {
		overpassUrl?: string;
		cache?: boolean;
		cacheDir?: string;
		fetcher?: typeof fetch;
		fetchOsmWays?: boolean;
	},
): Promise<{
	results: MatchResult[] | null;
	error?: string;
	osmWays?: OsmWay[];
	osmWaysAvailability?: DataSourceAvailability;
	osmWaysErrors?: string[];
	osmWaysCache?: { hits: number; misses: number };
	osmWaysCacheError?: string;
}> {
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
			osmWays: options.fetchOsmWays ? [] : undefined,
			osmWaysAvailability: options.fetchOsmWays
				? {
						status: "unavailable",
						source: data.source,
						requestedItems: data.totalChunks,
						availableItems: data.completedChunks,
						message: data.errors.join("; ") || "All Overpass queries failed.",
					}
				: undefined,
			osmWaysErrors: options.fetchOsmWays ? data.errors : undefined,
			osmWaysCache: options.fetchOsmWays ? data.cache : undefined,
			osmWaysCacheError: options.fetchOsmWays ? data.cacheError : undefined,
		};
	}
	const results = snapPointsToWays(points, data.ways, "overpass");
	const failed = data.totalChunks - data.completedChunks;
	const osmWaysAvailability = options.fetchOsmWays
		? {
				status: failed === 0 ? ("complete" as const) : ("partial" as const),
				source: data.source,
				requestedItems: data.totalChunks,
				availableItems: data.completedChunks,
				message:
					failed > 0
						? data.errors.join("; ") || `${failed} Overpass chunk(s) failed.`
						: undefined,
			}
		: undefined;
	if (failed > 0) {
		return {
			results,
			osmWays: options.fetchOsmWays ? data.ways : undefined,
			osmWaysAvailability,
			osmWaysErrors: options.fetchOsmWays ? data.errors : undefined,
			osmWaysCache: options.fetchOsmWays ? data.cache : undefined,
			osmWaysCacheError: options.fetchOsmWays ? data.cacheError : undefined,
			error: truncateText(
				`${failed} of ${data.totalChunks} Overpass chunks failed; nearby points may be unmatched. ${data.errors.slice(0, 3).join("; ")}`,
				200,
			),
		};
	}
	return {
		results,
		osmWays: options.fetchOsmWays ? data.ways : undefined,
		osmWaysAvailability,
		osmWaysErrors: options.fetchOsmWays ? data.errors : undefined,
		osmWaysCache: options.fetchOsmWays ? data.cache : undefined,
		osmWaysCacheError: options.fetchOsmWays ? data.cacheError : undefined,
	};
}
