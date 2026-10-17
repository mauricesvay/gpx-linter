import { describe, expect, it } from "vitest";
import { evaluateRules } from "../src/rules";
import { point } from "./fixtures";

describe("v1 rules", () => {
	it("smooths elevation noise and flags a sustained slope above threshold", () => {
		const points = [
			point(0, 0, 0, 0),
			point(0, 0.001, 0, 1),
			point(0, 0.002, 30, 2),
			point(0, 0.003, 30, 3),
		];
		const results = evaluateRules(points, {
			rules: {
				max_slope: { enabled: true, params: { max_percent: 10 } },
			},
		});
		expect(
			results.some(
				(result) => result.ruleId === "max_slope" && result.status === "fail",
			),
		).toBe(true);
	});

	it("does not turn an isolated elevation spike into a slope violation at segment edges", () => {
		const points = [
			point(0, 0, 0, 0),
			point(0, 0.001, 50, 1),
			point(0, 0.002, 0, 2),
		];
		const results = evaluateRules(points, {
			rules: { max_slope: { enabled: true, params: { max_percent: 10 } } },
		});
		expect(
			results.some(
				(result) => result.ruleId === "max_slope" && result.status === "fail",
			),
		).toBe(false);
	});

	it("does not flag short GPS jitter as a sharp turn", () => {
		const points = [
			point(0, 0, null, 0),
			point(0, 0.000001, null, 1),
			point(0.000001, 0.000001, null, 2),
		];
		const results = evaluateRules(points, {
			rules: {
				sharp_turn: {
					enabled: true,
					params: { max_angle: 40, min_segment_meters: 5 },
				},
			},
		});
		expect(
			results.some(
				(result) => result.ruleId === "sharp_turn" && result.status === "fail",
			),
		).toBe(false);
	});

	it("detects a roadworks buffer overlap and reports the feature", () => {
		const results = evaluateRules([point(48.8566, 2.3522)], {
			rules: {
				roadworks: {
					enabled: true,
					params: { buffer_meters: 5 },
					data: {
						type: "FeatureCollection",
						features: [
							{
								type: "Feature",
								properties: { name: "Bridge repairs" },
								geometry: { type: "Point", coordinates: [2.3522, 48.85664] },
							},
						],
					},
				},
			},
		});
		expect(results).toContainEqual(
			expect.objectContaining({
				ruleId: "roadworks",
				status: "fail",
				evidence: expect.objectContaining({ name: "Bridge repairs" }),
			}),
		);
	});

	it("returns unknown, not pass, when road matching is unavailable", () => {
		const results = evaluateRules([point(48, 2)], {
			rules: { contraflow_bike: { enabled: true } },
			roadMatching: {
				status: "unavailable",
				source: "osrm",
				requestedItems: 1,
				availableItems: 0,
			},
		});
		expect(results).toContainEqual(
			expect.objectContaining({
				ruleId: "contraflow_bike",
				status: "unknown",
			}),
		);
	});

	it("only reports contraflow when travel is opposite a one-way direction", () => {
		const points = [point(48, 2)];
		const route = (direction: "forward" | "backward") =>
			evaluateRules(points, {
				rules: { contraflow_bike: { enabled: true } },
				roadMatching: {
					status: "complete",
					source: "osrm",
					requestedItems: 1,
					availableItems: 1,
				},
				matches: [
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "123",
						tags: { highway: "residential", oneway: "yes" },
						direction,
					},
				],
			});

		expect(
			route("forward").find((result) => result.ruleId === "contraflow_bike")
				?.status,
		).toBe("pass");
		expect(
			route("backward").find((result) => result.ruleId === "contraflow_bike")
				?.status,
		).toBe("fail");
	});

	it("does not report a contraflow failure when OSM explicitly allows it", () => {
		for (const tags of [
			{ oneway: "yes", "oneway:bicycle": "no" },
			{ oneway: "yes", bicycle: "designated" },
		]) {
			const results = evaluateRules([point(48, 2)], {
				rules: { contraflow_bike: { enabled: true } },
				matches: [
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "123",
						tags,
						direction: "backward",
					},
				],
			});
			expect(
				results.find((result) => result.ruleId === "contraflow_bike")?.status,
			).toBe("pass");
		}
	});

	it("keeps off-road checks independent from ambiguous OSM enrichment", () => {
		const results = evaluateRules([point(48, 2)], {
			rules: {
				off_road: { enabled: true, params: { max_distance_meters: 50 } },
			},
			roadMatching: {
				status: "complete",
				source: "osrm",
				requestedItems: 1,
				availableItems: 1,
			},
			roadMatches: [
				{
					status: "matched",
					confidence: "high",
					score: 0.9,
					distanceToRoad: 8,
				},
			],
			matches: [
				{
					status: "ambiguous",
					confidence: "low",
					score: 0.9,
					reason: "Multiple OSM ways are nearby",
				},
			],
		});
		expect(results.find((result) => result.ruleId === "off_road")?.status).toBe(
			"pass",
		);
	});

	it("does not bridge track segment gaps or flag gaps allowed for ferries", () => {
		const points = [
			point(0, 0, null, 0),
			point(0, 0.001, null, 1),
			point(1, 1, null, 2),
		];
		const results = evaluateRules(points, {
			rules: { route_gaps: { enabled: true, params: { max_gap_meters: 500 } } },
			routeContext: { ferry_allowed: true },
		});
		expect(
			results.some(
				(result) => result.ruleId === "route_gaps" && result.status === "fail",
			),
		).toBe(false);
	});

	it("checks loop closure only when the route context expects a loop", () => {
		const points = [point(48, 2), point(48.1, 2.1, null, 1)];
		const notLoop = evaluateRules(points, {
			rules: { loop_closure: { enabled: true } },
		});
		const loop = evaluateRules(points, {
			rules: { loop_closure: { enabled: true } },
			routeContext: { loop_expected: true },
		});
		expect(
			notLoop.find((result) => result.ruleId === "loop_closure")?.status,
		).toBe("skipped");
		expect(
			loop.find((result) => result.ruleId === "loop_closure")?.status,
		).toBe("fail");
	});

	it("reports missing elevation percentage with explicit evidence", () => {
		const results = evaluateRules([point(0, 0, 10), point(0, 0.001, null, 1)], {
			rules: {
				missing_elevation: {
					enabled: true,
					params: { max_missing_elevation_percentage: 20 },
				},
			},
		});
		expect(results).toContainEqual(
			expect.objectContaining({
				ruleId: "missing_elevation",
				status: "fail",
				evidence: expect.objectContaining({ missingPercentage: 50 }),
			}),
		);
	});
});
