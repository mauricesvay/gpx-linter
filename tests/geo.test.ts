import { describe, expect, it } from "vitest";
import { isGeoJsonFeatureCollection, isWithinFeature } from "../src/geo";
import { bboxKeyString, routeBbox } from "../src/osm/cache";
import { point } from "./fixtures";

describe("GeoJSON roadworks geometry", () => {
	it("applies the configured buffer around line features", () => {
		const feature = {
			type: "Feature" as const,
			properties: {},
			geometry: {
				type: "LineString" as const,
				coordinates: [
					[1.999, 48],
					[2.001, 48],
				] as [number, number][],
			},
		};
		expect(isWithinFeature(point(48.00001, 2), feature, 2)).toBe(true);
		expect(isWithinFeature(point(48.001, 2), feature, 2)).toBe(false);
	});

	it("recognizes points inside polygon features and rejects malformed rings", () => {
		const polygon = {
			type: "Feature" as const,
			properties: {},
			geometry: {
				type: "Polygon" as const,
				coordinates: [
					[
						[1, 47],
						[3, 47],
						[3, 49],
						[1, 49],
						[1, 47],
					],
				] as [number, number][][],
			},
		};
		expect(isWithinFeature(point(48, 2), polygon, 0)).toBe(true);
		expect(
			isGeoJsonFeatureCollection({
				type: "FeatureCollection",
				features: [polygon],
			}),
		).toBe(true);
		expect(
			isGeoJsonFeatureCollection({
				type: "FeatureCollection",
				features: [
					{
						type: "Feature",
						geometry: {
							type: "Polygon",
							coordinates: [
								[
									[1, 1],
									[2, 2],
									[3, 3],
								],
							],
						},
					},
				],
			}),
		).toBe(false);
	});
});

describe("bboxKeyString / routeBbox", () => {
	it("produces different keys for bboxes with same grid origin but different sizes", () => {
		const shortRoute = [point(2.0, 48.0), point(2.01, 48.01)];
		const longRoute = [point(2.0, 48.0), point(2.5, 48.5)];
		const shortBbox = routeBbox(shortRoute);
		const longBbox = routeBbox(longRoute);
		expect(bboxKeyString(shortBbox)).not.toBe(bboxKeyString(longBbox));
	});

	it("includes all four coordinates in the key string", () => {
		const bbox = routeBbox([point(2.0, 48.0), point(3.0, 49.0)]);
		const key = bboxKeyString(bbox);
		const parts = key.split(",");
		expect(parts.length).toBe(4);
		// Verify the 4th component (lonMax) differs from the 3rd (latMax)
		// when latMax !== lonMax
		expect(parts[2]).not.toBe(parts[3]);
	});
});
