import { fetchOverpassBboxWays } from "./fetch";
import { snapSinglePoint, buildWayIndex, type IndexedWay } from "./snapping";
import type {
	DataSourceAvailability,
	MatchResult,
	Trackpoint,
} from "../types";
import {
	MAX_SNAP_DISTANCE_METERS,
	OVERPASS_TTL_MS,
	OVERPASS_PRIMARY,
	type OsmDataOptions,
	type OsmEnrichmentResult,
	type OsmWay,
	routeBbox,
} from "./cache";
import { DEFAULT_MAX_TRACK_POINTS } from "../constants";

/* ── enrichment: re-snap matched points for OSM data ────────────────── */

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
		const prevResult = results.length > 0 ? results[results.length - 1] : null;
		const prevRoadId = prevResult && prevResult.roadId ? String(prevResult.roadId) : null;

		const snap = snapSinglePoint(point, index, points, cells, indexed, prevRoadId);

		if (snap.nearMiss) {
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

		if (snap.ambiguous) {
			results.push({
				...match,
				status: "ambiguous",
				confidence: "low",
				reason: "Multiple nearby OSM roads have similarly plausible distances.",
				candidates: snap.allCandidates.slice(0, 5).map((candidate) => ({
					roadId: String(candidate.way.id),
					score: Math.max(0, candidate.combinedScore),
					highway: candidate.way.tags.highway,
					distanceToRoad: candidate.distance,
				})),
			});
			continue;
		}

		const { topCandidate } = snap;
		results.push({
			...match,
			roadId: String(topCandidate!.way.id),
			roadName: topCandidate!.way.tags.name,
			osmDistanceToRoad: topCandidate!.distance,
			tags: topCandidate!.way.tags,
			direction: snap.direction,
			provider: match.provider,
		});
	}
	return results;
}



/* ── public: enrich with OSM data ────────────────────────────────────── */

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
			osmWays: [],
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
			osmWays: [],
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
			osmWays: [],
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
		osmWays: data.ways,
		availability,
		providerErrors: data.errors,
		cache: data.cache,
		cacheError: data.cacheError,
	};
}

export const osmCacheTtlMilliseconds = OVERPASS_TTL_MS;
