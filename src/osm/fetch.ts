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
	CLI_VERSION,
	RATE_LIMIT_BASE_MS,
	RATE_LIMIT_MAX_MS,
	RATE_LIMIT_JITTER_FRACTION,
	RATE_LIMIT_BACKOFF_MULTIPLIER,
	MAX_REQUESTS_PER_SECOND,
} from "../constants";
import {
	CACHE_VERSION,
	DEFAULT_CACHE_DIR,
	OSM_CACHE_FILE_NAME,
	OVERPASS_FALLBACK,
	OVERPASS_PRIMARY,
	OVERPASS_TTL_MS,
	OVERPASS_TIMEOUT_MS,
	type OsmBbox,
	type OsmCacheEntry,
	type OsmData,
	type OsmDataOptions,
	type OsmWay,
	chunkBbox,
	readOsmCache,
	isOsmWay,
	bboxKey,
	bboxQuery,
} from "./cache";

/* ── Rate-limit / backoff helpers ───────────────────────────────────── */

/** Compute exponential backoff with jitter for a given attempt number. */
function computeBackoffMs(attempt: number): number {
	const baseMs = RATE_LIMIT_BASE_MS * Math.pow(RATE_LIMIT_BACKOFF_MULTIPLIER, attempt);
	const capped = Math.min(baseMs, RATE_LIMIT_MAX_MS);
	const jitter = Math.random() * capped * RATE_LIMIT_JITTER_FRACTION;
	return capped + jitter;
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
					"User-Agent": `gpxlint/${CLI_VERSION}`,
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
		// Respect Retry-After header when present.
		const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
		if (retryAfter !== null) {
			await delay(retryAfter);
			continue;
		}
		// Exponential backoff with jitter.
		await delay(computeBackoffMs(attempt));
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
			Date.now() - cached.storedAt < OVERPASS_TTL_MS
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
			const rateLimitWait = (1 / MAX_REQUESTS_PER_SECOND) * 1000 - (Date.now() - lastRequestAt);
			if (lastRequestAt > 0 && rateLimitWait > 0) await delay(rateLimitWait);
			lastRequestAt = Date.now();
			console.error(`[overpass] Fetching chunk: ${chunk.latMin.toFixed(4)},${chunk.lonMin.toFixed(4)} — ${chunk.latMax.toFixed(4)},${chunk.lonMax.toFixed(4)} (${url})`);
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
				version: CACHE_VERSION,
				source: "overpass",
				storedAt: Date.now(),
				ways: chunkWays,
				provider: supplier,
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
