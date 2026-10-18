import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRoads } from "../src/resolver/index";
import { point } from "./fixtures";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function overpassResponse(
	ways: {
		id: number;
		lat: number;
		lonStart: number;
		lonEnd: number;
		tags?: Record<string, string>;
	}[],
) {
	return JSON.stringify({
		elements: ways.map((way) => ({
			type: "way",
			id: way.id,
			tags: { highway: "residential", ...way.tags },
			geometry: [
				{ lat: way.lat, lon: way.lonStart },
				{ lat: way.lat, lon: way.lonEnd },
			],
		})),
	});
}

const overpassFetcher = (body: string) =>
	vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

// Two trackpoints close together so the route bbox produces a single chunk.
const points = [point(48, 2.008), point(48, 2.012)];

describe("road matching", () => {
	it("returns one unmatched result per point for malformed provider responses", async () => {
		const fetcher = overpassFetcher("{bad json");
		const result = await resolveRoads(points, {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.matches).toHaveLength(points.length);
		expect(result.matches.every((match) => match.status === "unmatched")).toBe(
			true,
		);
		expect(result.cache).toEqual({ hits: 0, misses: 0 });
	});

	it("reports matches as ambiguous when nearby roads are too close to distinguish", async () => {
		const fetcher = overpassFetcher(
			overpassResponse([
				{ id: 1, lat: 48, lonStart: 2.004, lonEnd: 2.02 },
				{ id: 2, lat: 48.000015, lonStart: 2.004, lonEnd: 2.02 },
			]),
		);
		const result = await resolveRoads(points, {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		// P0-3: ambiguous results are preserved in ambiguousMatches.
		// Continuity bonus resolves the 2nd point; only 1st stays ambiguous.
		expect(result.ambiguousMatches).toBeDefined();
		expect(result.ambiguousMatches?.length).toBe(1);
		expect(result.ambiguousMatches?.[0].status).toBe("ambiguous");
		expect(result.ambiguousMatches?.[0].confidence).toBe("low");
	});

	it("caches complete matches and reports cache hits on subsequent runs", async () => {
		const cacheDir = await mkdtemp(
			path.join(os.tmpdir(), "gpxlint-road-cache-"),
		);
		directories.push(cacheDir);
		const fetcher = overpassFetcher(
			overpassResponse([{ id: 1, lat: 48, lonStart: 2.004, lonEnd: 2.02 }]),
		);
		const options = {
			provider: "overpass" as const,
			url: "https://routing.invalid",
			cacheDir,
			fetcher,
		};

		const first = await resolveRoads(points, options);
		const second = await resolveRoads(points, options);

		expect(first.cache.misses).toBe(2);
		expect(second.cache.hits).toBe(2);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("reuses the Overpass response for way evaluation and persists road matches", async () => {
		const cacheDir = await mkdtemp(
			path.join(os.tmpdir(), "gpxlint-road-and-way-cache-"),
		);
		directories.push(cacheDir);
		const fetcher = overpassFetcher(
			overpassResponse([{ id: 1, lat: 48, lonStart: 2.004, lonEnd: 2.02 }]),
		);
		const options = {
			provider: "overpass" as const,
			url: "https://routing.invalid",
			cacheDir,
			fetcher,
			fetchOsmWays: true,
		};

		const first = await resolveRoads(points, options);
		const second = await resolveRoads(points, options);

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(first.osmWaysAvailability?.status).toBe("complete");
		expect(first.cache.misses).toBe(2);
		expect(second.cache.hits).toBe(2);
		expect(second.osmWaysAvailability?.status).toBe("complete");
	});

	it("fetches the route bbox only once when OSM way caching is disabled", async () => {
		const fetcher = overpassFetcher(
			overpassResponse([{ id: 1, lat: 48, lonStart: 2.004, lonEnd: 2.02 }]),
		);
		const result = await resolveRoads(points, {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetchOsmWays: true,
			fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(result.osmWaysAvailability?.status).toBe("complete");
	});

	it("retries a transient HTTP failure once when Retry-After permits it", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("", { status: 503, headers: { "retry-after": "0" } }),
			)
			.mockResolvedValue(
				new Response(
					overpassResponse([{ id: 1, lat: 48, lonStart: 2.004, lonEnd: 2.02 }]),
					{ status: 200 },
				),
			);
		const result = await resolveRoads(points, {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(result.matches[0].status).toBe("matched");
	});

	it("reports offline as unavailable without contacting any provider", async () => {
		const fetcher = vi.fn();
		const result = await resolveRoads(points, {
			provider: "offline",
			cache: false,
			fetcher,
		});

		expect(fetcher).not.toHaveBeenCalled();
		expect(result.availability.status).toBe("unavailable");
		expect(result.matches).toHaveLength(points.length);
		expect(result.matches.every((match) => match.status === "unmatched")).toBe(
			true,
		);
		expect(result.providerErrors[0]).toMatch(/offline/i);
	});

	it("matches points across multiple GPX segments in one query", async () => {
		const first = point(48, 2.005);
		const second = point(48.0002, 2.006);
		const third = { ...point(48.0004, 2.007, null, 0), segmentId: 1 };
		const fourth = { ...point(48.0006, 2.008, null, 0), segmentId: 1 };
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					elements: [
						{
							type: "way",
							id: 1,
							tags: { highway: "residential" },
							geometry: [
								{ lat: 48, lon: 2.005 },
								{ lat: 48.0006, lon: 2.008 },
							],
						},
					],
				}),
				{ status: 200 },
			),
		);
		const result = await resolveRoads([first, second, third, fourth], {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(result.matches).toHaveLength(4);
		expect(result.availability.status).toBe("complete");
	});

	it("includes the provider response body in HTTP error details", async () => {
		const fetcher = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						message: "Internal server error during matching.",
					}),
					{ status: 500, statusText: "Internal Server Error" },
				),
			),
		);
		const result = await resolveRoads(points, {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(result.providerErrors[0]).toContain("HTTP 500");
		expect(result.providerErrors[0]).toContain("routing.invalid");
		expect(result.providerErrors[0]).toContain(
			"Internal server error during matching.",
		);
	});

	it("leaves points unmatched when the returned road geometry is far away", async () => {
		const fetcher = overpassFetcher(
			overpassResponse([{ id: 1, lat: 50, lonStart: 3, lonEnd: 3.01 }]),
		);
		const result = await resolveRoads(points, {
			provider: "overpass",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.matches[0].status).toBe("unmatched");
	});
});
