import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRoads } from "../src/resolver";
import { point } from "./fixtures";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("road matching", () => {
	it("returns unavailable rather than an empty success for malformed provider responses", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response("{bad json", { status: 200 }));
		const result = await resolveRoads([point(48, 2), point(49, 3)], {
			provider: "osrm",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.matches[0].status).toBe("unmatched");
		expect(result.matches[0].confidence).toBe("unknown");
		expect(result.cache).toEqual({ hits: 0, misses: 0 });
	});

	it("keeps ambiguous matches unknown for safety rules", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "Ok",
					tracepoints: [
						{
							location: [2, 48],
							matchings_index: 0,
							waypoint_index: 0,
							distance: 3,
						},
						{
							location: [3, 49],
							matchings_index: 0,
							waypoint_index: 1,
							distance: 2,
						},
					],
					matchings: [
						{
							confidence: 0.4,
							legs: [
								{
									annotation: { nodes: [100, 101], distance: 10, duration: 1 },
								},
							],
							geometry: {
								coordinates: [
									[2, 48],
									[2.001, 48],
								],
							},
							weight: 1,
							distance: 10,
							duration: 1,
						},
					],
				}),
				{ status: 200 },
			),
		);
		const result = await resolveRoads([point(48, 2), point(49, 3)], {
			provider: "osrm",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(result.matches[0].status).toBe("ambiguous");
		expect(result.matches[0].confidence).toBe("low");
	});

	it("caches complete matches and reports cache hits on subsequent runs", async () => {
		const cacheDir = await mkdtemp(
			path.join(os.tmpdir(), "gpxlint-road-cache-"),
		);
		directories.push(cacheDir);
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "Ok",
					tracepoints: [
						{
							location: [2, 48],
							matchings_index: 0,
							waypoint_index: 0,
							distance: 2,
						},
						{
							location: [3, 49],
							matchings_index: 0,
							waypoint_index: 1,
							distance: 3,
						},
					],
					matchings: [{ confidence: 0.95 }],
				}),
				{ status: 200 },
			),
		);
		const options = {
			provider: "osrm" as const,
			url: "https://routing.invalid",
			cacheDir,
			fetcher,
		};

		const first = await resolveRoads([point(48, 2), point(49, 3)], options);
		const second = await resolveRoads([point(48, 2), point(49, 3)], options);

		expect(first.cache.misses).toBe(2);
		expect(second.cache.hits).toBe(2);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("retries a transient HTTP failure once when Retry-After permits it", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("", { status: 503, headers: { "retry-after": "0" } }),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						code: "Ok",
						tracepoints: [
							{
								location: [2, 48],
								matchings_index: 0,
								waypoint_index: 0,
								distance: 1,
							},
							{
								location: [3, 49],
								matchings_index: 0,
								waypoint_index: 1,
								distance: 2,
							},
						],
						matchings: [{ confidence: 0.9 }],
					}),
					{ status: 200 },
				),
			);
		const result = await resolveRoads([point(48, 2), point(49, 3)], {
			provider: "osrm",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(result.matches[0].status).toBe("matched");
	});

	it("uses the configured GraphHopper fallback when OSRM returns malformed data", async () => {
		const fetcher = vi.fn((input: string | URL | Request) => {
			if (String(input).includes("/match")) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							map_matching: {
								tracepoints: [
									{ matching_index: 0, distance: 2 },
									{ matching_index: 0, distance: 3 },
								],
								matchings: [{ confidence: 0.9 }],
							},
						}),
						{ status: 200 },
					),
				);
			}
			return Promise.resolve(new Response("{broken", { status: 200 }));
		});
		const result = await resolveRoads([point(48, 2), point(49, 3)], {
			provider: "osrm",
			fallback: "graphhopper",
			osrmUrl: "https://osrm.invalid",
			graphhopperUrl: "https://graphhopper.invalid",
			cache: false,
			fetcher,
		});

		expect(result.matches[0].status).toBe("matched");
		expect(result.matches[0].provider).toBe("graphhopper");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("does not send separate GPX segments as one continuous matching trace", async () => {
		const first = point(48, 2, null, 0);
		const second = point(48.1, 2.1, null, 0);
		const third = { ...point(48, 2, null, 1), segmentId: 1 };
		const fourth = { ...point(48.1, 2.1, null, 1), segmentId: 1 };
		const fetcher = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						code: "Ok",
						tracepoints: [
							{
								location: [2, 48],
								matchings_index: 0,
								waypoint_index: 0,
								distance: 1,
							},
							{
								location: [2.1, 48.1],
								matchings_index: 0,
								waypoint_index: 1,
								distance: 1,
							},
						],
						matchings: [{ confidence: 0.9 }],
					}),
					{ status: 200 },
				),
			),
		);
		const result = await resolveRoads([first, second, third, fourth], {
			provider: "osrm",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(result.matches).toHaveLength(4);
		expect(result.availability.status).toBe("complete");
	});

	it("rejects a provider response snapped nowhere near the requested coordinate", async () => {
		const fetcher = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					code: "Ok",
					tracepoints: [
						{
							location: [3, 49],
							matchings_index: 0,
							waypoint_index: 0,
							distance: 1,
						},
						{
							location: [4, 50],
							matchings_index: 0,
							waypoint_index: 1,
							distance: 2,
						},
					],
					matchings: [{ confidence: 0.9 }],
				}),
				{ status: 200 },
			),
		);
		const result = await resolveRoads([point(48, 2), point(49, 3)], {
			provider: "osrm",
			url: "https://routing.invalid",
			cache: false,
			fetcher,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.providerErrors[0]).toMatch(/did not correspond/i);
	});
});
