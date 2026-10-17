import { describe, expect, it, vi } from "vitest";
import { createReport, formatReport } from "../src/reporter";

describe("reporting", async () => {
	it("does not let an unknown rule outcome produce a clean exit status", () => {
		const report = createReport({
			routeName: "test.gpx",
			results: [
				{
					ruleId: "max_slope",
					status: "unknown",
					severity: "error",
					confidence: "low",
					message: "Elevation data missing",
				},
			],
			availability: {
				gpx: {
					status: "complete",
					source: "file",
					requestedItems: 1,
					availableItems: 1,
				},
				roadMatching: {
					status: "not_required",
					source: "routing",
					requestedItems: 0,
					availableItems: 0,
				},
				osm: {
					status: "not_required",
					source: "overpass",
					requestedItems: 0,
					availableItems: 0,
				},
				roadworks: {
					status: "not_required",
					source: "geojson",
					requestedItems: 0,
					availableItems: 0,
				},
				incomplete: false,
			},
			cache: { hits: 0, misses: 0 },
		});
		expect(report.availability.incomplete).toBe(true);
		expect(report.exitCode).toBe(2);
	});

	it("preserves unknown outcomes and assigns incomplete exit status", async () => {
		const report = createReport({
			routeName: "test.gpx",
			results: [
				{
					ruleId: "contraflow_bike",
					status: "unknown",
					severity: "error",
					confidence: "low",
					message: "Road matching unavailable",
					source: { provider: "osrm" },
				},
			],
			availability: {
				gpx: {
					status: "complete",
					source: "file",
					requestedItems: 1,
					availableItems: 1,
				},
				roadMatching: {
					status: "unavailable",
					source: "osrm",
					requestedItems: 1,
					availableItems: 0,
				},
				osm: {
					status: "not_required",
					source: "overpass",
					requestedItems: 0,
					availableItems: 0,
				},
				roadworks: {
					status: "not_required",
					source: "geojson",
					requestedItems: 0,
					availableItems: 0,
				},
				incomplete: true,
			},
			cache: { hits: 0, misses: 1 },
		});
		const json = JSON.parse(await formatReport(report, "json"));

		expect(json.summary.status.unknown).toBe(1);
		expect(json.exitCode).toBe(2);
		expect(await formatReport(report, "text")).toContain("roadMatching: unavailable");
	});

	it("keeps distance markers on the full route when map lines are color-segmented", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => Promise.resolve(new Response(""))),
		);
		try {
			const report = createReport({
				routeName: "test.gpx",
				results: [
					{
						ruleId: "roadworks",
						status: "fail",
						severity: "error",
						confidence: "high",
						message: "Test finding",
						lat: 48.001,
						lon: 2,
						pointIndex: 1,
						evidence: {
							properties: {
								description: "Closure <east> & west",
								date_fin: "2026-12-31",
							},
						},
					},
					{
						ruleId: "unknown_rule",
						status: "unknown",
						severity: "warning",
						confidence: "low",
						message: "Uncertain finding",
						lat: 48.002,
						lon: 2,
						pointIndex: 2,
					},
				],
				availability: {
					gpx: {
						status: "complete",
						source: "file",
						requestedItems: 3,
						availableItems: 3,
					},
					roadMatching: {
						status: "complete",
						source: "overpass",
						requestedItems: 3,
						availableItems: 3,
					},
					osm: {
						status: "not_required",
						source: "overpass",
						requestedItems: 0,
						availableItems: 0,
					},
					roadworks: {
						status: "not_required",
						source: "geojson",
						requestedItems: 0,
						availableItems: 0,
					},
					incomplete: false,
				},
				cache: { hits: 0, misses: 0 },
				trackCoords: [
					{ lat: 48, lon: 2, distanceFromStart: 0 },
					{ lat: 48.001, lon: 2, distanceFromStart: 111 },
					{ lat: 48.002, lon: 2, distanceFromStart: 222 },
				],
				matchedStatus: ["matched", "matched", "matched"],
				matchedHighway: ["residential", "cycleway", "residential"],
			});

			const html = await formatReport(report, "html");
			expect(html).toContain("L.polyline(track, {");
			expect(html).toContain("opacity: 0");
			expect(html).toContain("distanceMarkers: { offset: 1000 }");
			expect(html).toContain("L.polyline(seg.coords, {");
			expect(html).toContain("if (bounds.isValid())");
			expect(html).toContain("findings.forEach(function(f)");
			expect(html).toContain("Findings: 1 markers");
			expect(html).toContain('"message":"Test finding"');
			expect(html).toContain("f.evidence.properties");
			expect(html).toContain("function bindRoadworksTooltip(shape, properties)");
			expect(html).toContain("bindRoadworksTooltip(shape, f.evidence.properties)");
			expect(html).not.toContain("marker.bindTooltip");
			expect(html).toContain('"description":"Closure <east> & west"');
			expect(html).not.toContain('"message":"Uncertain finding"');
			expect(html).not.toMatch(
				/L\.polyline\(seg\.coords, \{[^}]*distanceMarkers/s,
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
