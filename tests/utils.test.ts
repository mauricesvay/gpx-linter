import { describe, expect, it } from "vitest";
import { confidenceFromScore } from "../src/utils";

describe("confidenceFromScore", () => {
	it("returns 'low' for scores below 0.6", () => {
		expect(confidenceFromScore(0)).toBe("low");
		expect(confidenceFromScore(0.59)).toBe("low");
	});

	it("returns 'medium' for scores 0.60–0.79", () => {
		expect(confidenceFromScore(0.6)).toBe("medium");
		expect(confidenceFromScore(0.65)).toBe("medium");
		expect(confidenceFromScore(0.79)).toBe("medium");
	});

	it("returns 'high' for scores ≥ 0.80", () => {
		expect(confidenceFromScore(0.8)).toBe("high");
		expect(confidenceFromScore(0.85)).toBe("high");
		expect(confidenceFromScore(0.99)).toBe("high");
		expect(confidenceFromScore(1.0)).toBe("high");
	});

	it("handles negative scores", () => {
		expect(confidenceFromScore(-0.1)).toBe("low");
	});
});
