import { isWithinFeature } from "../geo";
import type {
	GeoJsonFeatureCollection,
	RuleDefinition,
	RuleResult,
	Severity,
	Trackpoint,
} from "../types";
import { isFeatureCollection, numberParam, result } from "./utils";

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
 *
 * The GeoJSON file can be supplied via the CLI `--geojson` flag or via the
 * `roadworks.params.geojson_file` config key. Each feature's `name` property
 * is used in the output message; unnamed features are labelled "Unnamed roadworks".
 *
 * @param definition — rule definition containing severity, params, and data (GeoJSON)
 * @param points   — ordered trackpoints from the GPX file
 * @returns array of rule results (one per matching point, or a single pass result)
 */
export function roadworks(
	definition: RuleDefinition,
	points: Trackpoint[],
): RuleResult[] {
	const geoJson =
		definition.data ??
		(definition.params?.geojson as GeoJsonFeatureCollection | undefined);
	if (!isFeatureCollection(geoJson)) {
		return [
			result(
				"roadworks",
				definition,
				"warning",
				"unknown",
				"Roadworks GeoJSON is not configured or is invalid.",
				"low",
				undefined,
				{ source: "roadworks" },
			),
		];
	}
	const buffer = numberParam(definition, "buffer_meters", 5);
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
						bufferMeters: buffer,
						geometryType: feature.geometry.type,
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
