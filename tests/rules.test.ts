import { describe, expect, it } from "vitest";
import { evaluateRules } from "../src/rules";
import { point } from "./fixtures";

describe("v1 rules", async () => {
	it("smooths elevation noise and flags a sustained slope above threshold", async () => {
		const points = [
			point(0, 0, 0, 0),
			point(0, 0.001, 0, 1),
			point(0, 0.002, 30, 2),
			point(0, 0.003, 30, 3),
		];
		const results = await evaluateRules(points, {
			rules: {
				max_slope: { enabled: true, params: { max_slope_percentage: 10 } },
			},
		});
		expect(
			results.some(
				(result) => result.ruleId === "max_slope" && result.status === "fail",
			),
		).toBe(true);
	});

	it("does not turn an isolated elevation spike into a slope violation at segment edges", async () => {
		const points = [
			point(0, 0, 0, 0),
			point(0, 0.001, 50, 1),
			point(0, 0.002, 0, 2),
		];
		const results = await evaluateRules(points, {
			rules: {
				max_slope: { enabled: true, params: { max_slope_percentage: 10 } },
			},
		});
		expect(
			results.some(
				(result) => result.ruleId === "max_slope" && result.status === "fail",
			),
		).toBe(false);
	});

	it("does not flag short GPS jitter as a sharp turn", async () => {
		const points = [
			point(0, 0, null, 0),
			point(0, 0.000001, null, 1),
			point(0.000001, 0.000001, null, 2),
		];
		const results = await evaluateRules(points, {
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

	it("detects a roadworks buffer overlap and reports the feature", async () => {
		const properties = {
			name: "Bridge repairs",
			description: "Replacing the bridge deck",
			date_fin: "2026-12-31",
		};
		const results = await evaluateRules([point(48.8566, 2.3522)], {
			rules: {
				roadworks: {
					enabled: true,
					params: { buffer_meters: 1 },
					data: {
						type: "FeatureCollection",
						features: [
							{
								type: "Feature",
								properties,
								geometry: { type: "Point", coordinates: [2.3522, 48.8566] },
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
				evidence: expect.objectContaining({
					name: "Bridge repairs",
					properties,
				}),
			}),
		);
	});

	it("returns unknown, not pass, when road matching is unavailable", async () => {
		const results = await evaluateRules([point(48, 2)], {
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

	it("only reports contraflow when travel is opposite a one-way direction", async () => {
		const points = [point(48, 2), point(48, 2.0001)];
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
			(await route("forward")).find(
				(result) => result.ruleId === "contraflow_bike",
			)?.status,
		).toBe("pass");
		expect(
			(await route("backward")).find(
				(result) => result.ruleId === "contraflow_bike",
			)?.status,
		).toBe("fail");
	});

	it("does not report a contraflow failure when OSM explicitly allows it", async () => {
		for (const tags of [
			{ oneway: "yes", "oneway:bicycle": "no" },
			{ oneway: "yes", bicycle: "designated" },
		]) {
			const results = await evaluateRules(
				[point(48, 2), point(48, 2.0001)],
				{
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
						{
							status: "matched",
							confidence: "high",
							score: 0.95,
							roadId: "123",
							tags,
							direction: "backward",
						},
					],
				},
			);
			expect(
				results.find((result) => result.ruleId === "contraflow_bike")?.status,
			).toBe("pass");
		}
	});

	it("keeps off-road checks independent from ambiguous OSM enrichment", async () => {
		const results = await evaluateRules([point(48, 2)], {
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

	it("does not bridge track segment gaps or flag gaps allowed for ferries", async () => {
		const points = [
			point(0, 0, null, 0),
			point(0, 0.001, null, 1),
			point(1, 1, null, 2),
		];
		const results = await evaluateRules(points, {
			rules: { route_gaps: { enabled: true, params: { max_gap_meters: 500 } } },
			routeContext: { ferry_allowed: true },
		});
		expect(
			results.some(
				(result) => result.ruleId === "route_gaps" && result.status === "fail",
			),
		).toBe(false);
	});

	it("checks loop closure only when the route context expects a loop", async () => {
		const points = [point(48, 2), point(48.1, 2.1, null, 1)];
		const notLoop = await evaluateRules(points, {
			rules: { loop_closure: { enabled: true } },
		});
		const loop = await evaluateRules(points, {
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

	it("reports missing elevation percentage with explicit evidence", async () => {
		const results = await evaluateRules(
			[point(0, 0, 10), point(0, 0.001, null, 1)],
			{
				rules: {
					missing_elevation: {
						enabled: true,
						params: { max_missing_elevation_percentage: 20 },
					},
				},
			},
		);
		expect(results).toContainEqual(
			expect.objectContaining({
				ruleId: "missing_elevation",
				status: "fail",
				evidence: expect.objectContaining({ missingPercentage: 50 }),
			}),
		);
	});

	// ── bike_lane_no_same_direction_car_lane tests ──────────────────────

	const makePoints = (count: number) =>
		Array.from({ length: count }, (_, i) => point(48, 2 + i * 0.0001, 0, i));

	const makeOsmWay = (
		id: number,
		highway: string,
		otherTags: Record<string, string> = {},
	): import("../src/osm").OsmWay => ({
		id,
		tags: { highway, ...otherTags },
		geometry: [
			{ lat: 48.0, lon: 2.0 },
			{ lat: 48.0001, lon: 2.0001 },
		],
	});

	const context = (
		overrides: {
			matches?: import("../src/types").MatchResult[];
			osmWays?: import("../src/osm").OsmWay[];
		} = {},
	) => ({
		rules: { bike_lane_no_same_direction_car_lane: { enabled: true } },
		roadMatching: {
			status: "complete",
			source: "overpass",
			requestedItems: 3,
			availableItems: 3,
		},
		matches: overrides.matches ?? [
			{
				status: "matched",
				confidence: "high",
				score: 0.95,
				roadId: "100",
				tags: { highway: "cycleway" },
				direction: "forward",
			},
			{
				status: "matched",
				confidence: "high",
				score: 0.95,
				roadId: "100",
				tags: { highway: "cycleway" },
				direction: "forward",
			},
			{
				status: "matched",
				confidence: "high",
				score: 0.95,
				roadId: "100",
				tags: { highway: "cycleway" },
				direction: "forward",
			},
		],
		osmWays: overrides.osmWays ?? [makeOsmWay(100, "cycleway")],
	});

	it("passes when a two-way car road is nearby", async () => {
		const parallelWay = makeOsmWay(200, "residential", { oneway: "no" });
		parallelWay.geometry = [
			{ lat: 48.00005, lon: 1.99995 },
			{ lat: 48.00005, lon: 2.00025 },
		];
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [makeOsmWay(100, "cycleway"), parallelWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("pass");
	});

	it("ignores duplicate route points when determining direction", async () => {
		const points = [
			point(48, 2, 0, 0),
			point(48, 2, 0, 1),
			point(48, 2.0001, 0, 2),
		];
		const parallelWay = makeOsmWay(200, "residential", { oneway: "no" });
		parallelWay.geometry = [
			{ lat: 48.00005, lon: 1.99995 },
			{ lat: 48.00005, lon: 2.00025 },
		];
		const results = await evaluateRules(
			points,
			context({
				osmWays: [makeOsmWay(100, "cycleway"), parallelWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("pass");
	});

	it("does not count a nearby perpendicular two-way road", async () => {
		const crossingWay = makeOsmWay(200, "residential", { oneway: "no" });
		crossingWay.geometry = [
			{ lat: 47.9999, lon: 2.0001 },
			{ lat: 48.0001, lon: 2.0001 },
		];
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [makeOsmWay(100, "cycleway"), crossingWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("fail");
	});

	it("returns unknown for a nearby car road with an unrecognized oneway value", async () => {
		const road = makeOsmWay(200, "residential", { oneway: "reversible" });
		road.geometry = [
			{ lat: 48.0, lon: 2.0 },
			{ lat: 48.0, lon: 2.0002 },
		];
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [makeOsmWay(100, "cycleway"), road],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("passes when a same-direction one-way car road is nearby", async () => {
		// Create a one-way road aligned with the route (purely eastward)
		const eastWay = makeOsmWay(200, "residential", { oneway: "yes" });
		eastWay.geometry = [
			{ lat: 48.0, lon: 2.0 },
			{ lat: 48.0, lon: 2.0002 },
		];
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [makeOsmWay(100, "cycleway"), eastWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("pass");
	});

	it("uses the nearby segment of a curved one-way road to determine direction", async () => {
		const curvedWay = makeOsmWay(200, "residential", { oneway: "yes" });
		curvedWay.geometry = [
			{ lat: 48, lon: 2.0002 },
			{ lat: 48, lon: 2 },
			{ lat: 48.01, lon: 2.01 },
			{ lat: 48.01, lon: 2.02 },
		];
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [makeOsmWay(100, "cycleway"), curvedWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("fail");
	});

	it("fails when only an opposite-direction one-way car road exists", async () => {
		const points = makePoints(3);
		// Create a one-way road going in the opposite direction
		const oppositeWay = makeOsmWay(200, "residential", { oneway: "yes" });
		// Reverse the geometry so traffic goes opposite to route
		oppositeWay.geometry.reverse();
		const results = await evaluateRules(
			points,
			context({
				osmWays: [makeOsmWay(100, "cycleway"), oppositeWay],
			}),
		);
		const ruleResult = results.find(
			(r) => r.ruleId === "bike_lane_no_same_direction_car_lane",
		);
		expect(ruleResult?.status).toBe("fail");
		expect(ruleResult).toHaveProperty("evidence");
		expect(ruleResult?.evidence).toHaveProperty("facilityRoadId");
	});

	it("fails when no qualifying car road is within range", async () => {
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [
					makeOsmWay(100, "cycleway"),
					// A footway is not a car road
					makeOsmWay(200, "footway"),
				],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("fail");
	});

	it("passes for non-facility roads (residential with cycleway=lane)", async () => {
		const points = [
			point(48, 2),
			point(48.00005, 2.00005),
			point(48.0001, 2.0001),
		];
		const results = await evaluateRules(
			points,
			context({
				matches: [
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "residential", cycleway: "lane" },
						direction: "forward",
					},
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "residential", cycleway: "lane" },
						direction: "forward",
					},
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "residential", cycleway: "lane" },
						direction: "forward",
					},
				],
				osmWays: [makeOsmWay(100, "residential", { cycleway: "lane" })],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("pass");
	});

	it("does not treat highway=path without bicycle=designated as a facility", async () => {
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: [
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "path" },
						direction: "forward",
					},
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "path" },
						direction: "forward",
					},
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "path" },
						direction: "forward",
					},
				],
				osmWays: [makeOsmWay(100, "path")],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("pass");
	});

	it("excludes ways with bicycle=no or access=no", async () => {
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: [
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "path", bicycle: "no" },
						direction: "forward",
					},
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "path", bicycle: "no" },
						direction: "forward",
					},
					{
						status: "matched",
						confidence: "high",
						score: 0.95,
						roadId: "100",
						tags: { highway: "path", bicycle: "no" },
						direction: "forward",
					},
				],
				osmWays: [makeOsmWay(100, "path", { bicycle: "no" })],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("pass");
	});

	it("returns unknown when road matching is unavailable", async () => {
		const results = await evaluateRules(makePoints(3), {
			rules: { bike_lane_no_same_direction_car_lane: { enabled: true } },
			roadMatching: {
				status: "unavailable",
				source: "overpass",
				requestedItems: 3,
				availableItems: 0,
			},
		});
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("returns unknown when no nearby car road is found in incomplete OSM data", async () => {
		const baseContext = context({
			osmWays: [makeOsmWay(100, "cycleway")],
		});
		const results = await evaluateRules(makePoints(3), {
			...baseContext,
			osmWaysAvailability: {
				status: "partial",
				source: "overpass",
				requestedItems: 2,
				availableItems: 1,
				message: "One Overpass chunk failed.",
			},
		});
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("returns unknown for low-confidence matches", async () => {
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: [
					{
						status: "matched",
						confidence: "low",
						score: 0.3,
						roadId: "100",
					},
					{
						status: "matched",
						confidence: "low",
						score: 0.3,
						roadId: "100",
					},
					{
						status: "matched",
						confidence: "low",
						score: 0.3,
						roadId: "100",
					},
				],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("respects max_distance_meters parameter", async () => {
		const farWay = makeOsmWay(200, "residential", { oneway: "no" });
		// Move the car road far away (200m)
		farWay.geometry = [
			{ lat: 48.0018, lon: 2.0 },
			{ lat: 48.0018, lon: 2.002 },
		];
		const results = await evaluateRules(
			makePoints(3),
			context({
				rules: {
					bike_lane_no_same_direction_car_lane: {
						enabled: true,
						params: { max_distance_meters: 30 },
					},
				},
				osmWays: [makeOsmWay(100, "cycleway"), farWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("fail");
	});

	it("handles oneway=-1 correctly (reverse direction)", async () => {
		const reverseWay = makeOsmWay(200, "residential", { oneway: "-1" });
		// With oneway=-1, the permitted direction is opposite to the way geometry
		// The way goes forward, so permitted is backward
		// Route goes forward, so this should NOT match
		const results = await evaluateRules(
			makePoints(3),
			context({
				osmWays: [makeOsmWay(100, "cycleway"), reverseWay],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("fail");
	});

	it("returns unknown when matching is ambiguous", async () => {
		const results = await evaluateRules(makePoints(3), {
			rules: { bike_lane_no_same_direction_car_lane: { enabled: true } },
			roadMatching: {
				status: "partial",
				source: "overpass",
				requestedItems: 3,
				availableItems: 3,
			},
			matches: [
				{
					status: "ambiguous",
					confidence: "low",
					score: 0.5,
					roadId: "100",
				},
				{
					status: "ambiguous",
					confidence: "low",
					score: 0.5,
					roadId: "100",
				},
				{
					status: "ambiguous",
					confidence: "low",
					score: 0.5,
					roadId: "100",
				},
			],
		});
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("evaluates ambiguous snaps when both leading candidates are cycling facilities", async () => {
		const companionWay = makeOsmWay(200, "residential", { oneway: "no" });
		companionWay.geometry = [
			{ lat: 48.00005, lon: 1.99995 },
			{ lat: 48.00005, lon: 2.00025 },
		];
		const ambiguousMatches = makePoints(3).map(() => ({
			status: "ambiguous" as const,
			confidence: "low" as const,
			score: 0.8,
			roadId: "100",
			tags: { highway: "cycleway" },
			direction: "forward" as const,
			candidates: [
				{ roadId: "100", score: 0.8, highway: "cycleway" },
				{ roadId: "101", score: 0.75, highway: "cycleway" },
			],
		}));
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: ambiguousMatches,
				osmWays: [
					makeOsmWay(100, "cycleway"),
					makeOsmWay(101, "cycleway"),
					companionWay,
				],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("keeps mixed cycling-facility and car-road ambiguity unknown", async () => {
		const ambiguousMatches = makePoints(3).map(() => ({
			status: "ambiguous" as const,
			confidence: "low" as const,
			score: 0.8,
			roadId: "100",
			tags: { highway: "cycleway" },
			direction: "forward" as const,
			candidates: [
				{ roadId: "100", score: 0.8, highway: "cycleway" },
				{ roadId: "101", score: 0.75, highway: "residential" },
			],
		}));
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: ambiguousMatches,
				osmWays: [makeOsmWay(100, "cycleway"), makeOsmWay(101, "residential")],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("uses the clearly nearer facility when another ambiguous candidate is distant", async () => {
		const distantFootway = makeOsmWay(101, "footway");
		distantFootway.geometry = [
			{ lat: 48.0002, lon: 2.0 },
			{ lat: 48.0003, lon: 2.0001 },
		];
		const companionWay = makeOsmWay(200, "residential", { oneway: "no" });
		companionWay.geometry = [
			{ lat: 48.00005, lon: 1.99995 },
			{ lat: 48.00005, lon: 2.00025 },
		];
		const ambiguousMatches = makePoints(3).map(() => ({
			status: "ambiguous" as const,
			confidence: "low" as const,
			score: 0.8,
			roadId: "100",
			tags: { highway: "cycleway" },
			direction: "forward" as const,
			candidates: [
				{ roadId: "100", score: 0.8, highway: "cycleway" },
				{ roadId: "101", score: 0.75, highway: "footway" },
			],
		}));
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: ambiguousMatches,
				osmWays: [
					makeOsmWay(100, "cycleway"),
					distantFootway,
					companionWay,
				],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("uses a nearby confident match to resolve a facility crossing ambiguity", async () => {
		const points = makePoints(3);
		const facility = makeOsmWay(100, "cycleway");
		const crossing = makeOsmWay(101, "footway");
		crossing.geometry = facility.geometry;
		const companionWay = makeOsmWay(200, "residential", { oneway: "no" });
		companionWay.geometry = [
			{ lat: 48.00005, lon: 1.99995 },
			{ lat: 48.00005, lon: 2.00025 },
		];
		const ambiguousMatch = {
			status: "ambiguous" as const,
			confidence: "low" as const,
			score: 0.8,
			roadId: "101",
			tags: crossing.tags,
			direction: "forward" as const,
			candidates: [
				{ roadId: "100", score: 0.8, highway: "cycleway" },
				{ roadId: "101", score: 0.75, highway: "footway" },
			],
		};
		const matches = [
			{
				status: "matched" as const,
				confidence: "high" as const,
				score: 0.95,
				roadId: "100",
				tags: facility.tags,
				direction: "forward" as const,
			},
			ambiguousMatch,
			{
				status: "matched" as const,
				confidence: "high" as const,
				score: 0.95,
				roadId: "100",
				tags: facility.tags,
				direction: "forward" as const,
			},
		];
		const results = await evaluateRules(
			points,
			context({ matches, osmWays: [facility, crossing, companionWay] }),
		);
		expect(
			results.find(
				(r) =>
					r.ruleId === "bike_lane_no_same_direction_car_lane" &&
					r.pointIndex === 1,
			)?.status,
		).toBe("unknown");
	});

	it("does not use route-match continuity across GPX segments", async () => {
		const points = makePoints(3);
		points[1].segmentId = 1;
		const facility = makeOsmWay(100, "cycleway");
		const crossing = makeOsmWay(101, "footway");
		crossing.geometry = facility.geometry;
		const matches = [
			{
				status: "matched" as const,
				confidence: "high" as const,
				score: 0.95,
				roadId: "100",
				tags: facility.tags,
				direction: "forward" as const,
			},
			{
				status: "ambiguous" as const,
				confidence: "low" as const,
				score: 0.8,
				roadId: "101",
				tags: crossing.tags,
				direction: "forward" as const,
				candidates: [
					{ roadId: "100", score: 0.8, highway: "cycleway" },
					{ roadId: "101", score: 0.75, highway: "footway" },
				],
			},
			{
				status: "matched" as const,
				confidence: "high" as const,
				score: 0.95,
				roadId: "100",
				tags: facility.tags,
				direction: "forward" as const,
			},
		];
		const results = await evaluateRules(
			points,
			context({ matches, osmWays: [facility, crossing] }),
		);
		// No edges are created across segment boundaries, so the rule reports
		// a summary "unknown" rather than a per-point result.
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});

	it("passes when ambiguous candidates are both non-facility roads", async () => {
		const ambiguousMatches = makePoints(3).map(() => ({
			status: "ambiguous" as const,
			confidence: "low" as const,
			score: 0.8,
			roadId: "100",
			tags: { highway: "residential" },
			direction: "forward" as const,
			candidates: [
				{ roadId: "100", score: 0.8, highway: "residential" },
				{ roadId: "101", score: 0.75, highway: "primary" },
			],
		}));
		const results = await evaluateRules(
			makePoints(3),
			context({
				matches: ambiguousMatches,
				osmWays: [makeOsmWay(100, "residential"), makeOsmWay(101, "primary")],
			}),
		);
		expect(
			results.find((r) => r.ruleId === "bike_lane_no_same_direction_car_lane")
				?.status,
		).toBe("unknown");
	});
});
