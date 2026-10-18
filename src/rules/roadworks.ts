import { z } from "zod";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { isWithinFeature } from "../geo";
import type {
	GeoJsonFeatureCollection,
	GeoJsonGeometry,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "../types";
import { errorMessage } from "../utils";
import { isFeatureCollection, numberParam, result } from "./utils";

/** Zod schema for roadworks rule parameters. */
export const roadworksParamsSchema = z.object({
	buffer_meters: z.number().optional(),
	geojson_file: z.string().optional(),
});

/** Infer roadworks params type from schema. */
export type RoadworksParamsInput = z.infer<typeof roadworksParamsSchema>;

/** Convert GeoJSON coordinates [lon, lat] to Leaflet format [lat, lon]. */
function geoJsonToLeafletCoords(geometry: GeoJsonGeometry | null): {
	type: string;
	coordinates: unknown;
} | null {
	if (geometry === null) return null;
	const convert = (coords: unknown): unknown => {
		if (Array.isArray(coords)) {
			if (typeof coords[0] === "number") {
				// [lon, lat] → [lat, lon]
				return [coords[1], coords[0]];
			}
			return coords.map(convert);
		}
		return coords;
	};
	return { type: geometry.type, coordinates: convert(geometry.coordinates) };
}

/**
 * Flags trackpoints that are near roadworks / construction zones.
 *
 * Checks whether any route point falls within a configurable buffer zone around
 * features defined in an external GeoJSON file. The GeoJSON file should contain
 * features (Point, LineString, or Polygon) representing construction zones.
 *
 * Parameters
 *   buffer_meters — radius (in metres) around each GeoJSON feature to check
 *                   (default: 5)
 *   geojson_file  — path to the GeoJSON file (relative to config file path)
 *
 * Each feature's `name` property is used in the output message; unnamed
 * features are labelled "Unnamed roadworks".
 *
 * @param definition — rule definition containing severity and params
 * @param points   — ordered trackpoints from the GPX file
 * @returns array of rule results (one per matching point, or a single pass result)
 */
export async function roadworks(
	definition: RuleDefinition,
	points: Trackpoint[],
): Promise<RuleResult[]> {
	const geojsonPath = definition.params?.geojson_file;
	let geoJson: GeoJsonFeatureCollection | undefined;

	// Use inline data if provided (tests, programmatic use)
	const inlineData = definition.data;
	if (isFeatureCollection(inlineData)) {
		geoJson = inlineData;
	} else if (typeof geojsonPath === "string") {
		// Load and validate from file path
		try {
			const contents = await readFile(geojsonPath, "utf8");
			const parsed: unknown = JSON.parse(contents);
			if (!isFeatureCollection(parsed)) {
				throw new Error(
					`GeoJSON file "${geojsonPath}" is not a valid FeatureCollection. Expected {"type":"FeatureCollection","features":[...]}.`,
				);
			}
			geoJson = parsed;
		} catch (error) {
			if (
				error instanceof Error &&
				error.message.includes("not a valid FeatureCollection")
			) {
				throw error;
			}
			throw new Error(
				`Unable to load GeoJSON file "${geojsonPath}": ${errorMessage(error)}`,
			);
		}
	}

	if (!isFeatureCollection(geoJson)) {
		throw new Error(
			"Roadworks rule is enabled but no valid GeoJSON data is available. " +
				"Provide a valid GeoJSON FeatureCollection via `geojson_file` in config or `data` in rule definition.",
		);
	}
	const buffer = numberParam(definition, "buffer_meters", 1);
	const results: RuleResult[] = [];
	for (const point of points) {
		for (const feature of geoJson.features) {
			if (!isWithinFeature(point, feature, buffer)) continue;
			if (feature.geometry === null) continue;
			const properties = feature.properties ?? {};
			const name =
				typeof properties.name === "string"
					? properties.name
					: "Unnamed roadworks";
			const geometry = feature.geometry;
			const geometryCoords = geoJsonToLeafletCoords(geometry);
			results.push(
				result(
					"roadworks",
					definition,
					"warning",
					"fail",
					`Route is within ${buffer}m of roadworks: ${name}.`,
					"high",
					point,
					{
						name,
						type: properties.type ?? null,
						properties,
						bufferMeters: buffer,
						geometryType: geometry?.type ?? null,
						geometry: geometryCoords,
					},
					{ source: "geojson" },
				),
			);
		}
	}
	if (results.length === 0)
		results.push(
			result(
				"roadworks",
				definition,
				"warning",
				"pass",
				"No route point overlaps the configured roadworks buffer.",
				"high",
				undefined,
				{ featuresChecked: geoJson.features.length, bufferMeters: buffer },
				{ source: "geojson" },
			),
		);
	return results;
}
