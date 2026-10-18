import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { type RouteResolver, runLinter } from "../src/linter";
import type { ResolutionResult } from "../src/resolver";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("linter output data requirements", () => {
	it("resolves roads for HTML map coloring when road-dependent rules are disabled", async () => {
		const config = await loadConfig();
		for (const rule of Object.values(config.rules)) rule.enabled = false;
		config.reporting = { ...config.reporting, format: "html" };

		const gpx = `<gpx><trk><trkseg>
			<trkpt lat="48" lon="2"><ele>10</ele></trkpt>
			<trkpt lat="48.001" lon="2.001"><ele>11</ele></trkpt>
		</trkseg></trk></gpx>`;
		const resolve = vi.fn<RouteResolver["resolve"]>(
			async (points, _options): Promise<ResolutionResult> => ({
				matches: points.map(() => ({
					status: "matched",
					confidence: "high",
					score: 0.9,
					tags: { highway: "residential" },
				})),
				availability: {
					status: "complete",
					source: "overpass",
					requestedItems: points.length,
					availableItems: points.length,
				},
				cache: { hits: 0, misses: 0 },
				providerErrors: [],
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => Promise.resolve(new Response(""))),
		);

		const { report } = await runLinter({
			file: "route.gpx",
			config,
			cache: false,
			output: "report.html",
			deps: {
				resolver: { resolve },
				fs: {
					readFile: async () => gpx,
					writeFile: async () => {},
				},
			},
		});

		expect(resolve).toHaveBeenCalledOnce();
		expect(report.matchedStatus).toEqual(["matched", "matched"]);
		expect(report.matchedHighway).toEqual(["residential", "residential"]);
	});
});
