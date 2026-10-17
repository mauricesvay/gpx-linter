import type {
	GeoJsonFeature,
	GeoJsonFeatureCollection,
	GeoJsonGeometry,
	Trackpoint,
} from "./types";
import { isRecord, minimum } from "./utils";

const EARTH_RADIUS_METERS = 6_371_000;

/**
 * Calculates the great-circle distance between two geographic points using the haversine formula.
 * @returns Distance in meters.
 */
export function distanceMeters(
	a: Pick<Trackpoint, "lat" | "lon">,
	b: Pick<Trackpoint, "lat" | "lon">,
): number {
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const deltaLat = lat2 - lat1;
	const deltaLon = toRadians(b.lon - a.lon);
	const haversine =
		Math.sin(deltaLat / 2) ** 2 +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
	return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

/**
 * Calculates the initial bearing (direction) from point A to point B in degrees.
 * @returns Bearing in degrees (0–360), where 0° is north.
 */
export function bearingDegrees(
	a: Pick<Trackpoint, "lat" | "lon">,
	b: Pick<Trackpoint, "lat" | "lon">,
): number {
	const lat1 = toRadians(a.lat);
	const lat2 = toRadians(b.lat);
	const deltaLon = toRadians(b.lon - a.lon);
	const y = Math.sin(deltaLon) * Math.cos(lat2);
	const x =
		Math.cos(lat1) * Math.sin(lat2) -
		Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
	return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Calculates the shortest distance (in meters) from a geographic point to a GeoJSON geometry.
 * Handles all geometry types: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.
 * @returns Distance in meters; returns positive infinity for invalid/empty geometries.
 */
export function pointToGeometryDistanceMeters(
	point: Pick<Trackpoint, "lat" | "lon">,
	geometry: GeoJsonGeometry,
): number {
	switch (geometry.type) {
		case "Point":
			return distanceMeters(point, {
				lon: geometry.coordinates[0],
				lat: geometry.coordinates[1],
			});
		case "MultiPoint":
			return minimum(
				geometry.coordinates.map(([lon, lat]) =>
					distanceMeters(point, { lat, lon }),
				),
			);
		case "LineString":
			return lineDistance(point, geometry.coordinates);
		case "MultiLineString":
			return minimum(
				geometry.coordinates.map((line) => lineDistance(point, line)),
			);
		case "Polygon":
			return polygonDistance(point, geometry.coordinates);
		case "MultiPolygon":
			return minimum(
				geometry.coordinates.map((polygon) => polygonDistance(point, polygon)),
			);
	}
}

/**
 * Checks whether a geographic point lies within a certain buffer distance of a GeoJSON feature.
 * Returns false if the feature has null geometry.
 */
export function isWithinFeature(
	point: Pick<Trackpoint, "lat" | "lon">,
	feature: GeoJsonFeature,
	bufferMeters: number,
): boolean {
	if (feature.geometry === null) return false;
	return pointToGeometryDistanceMeters(point, feature.geometry) <= bufferMeters;
}

/**
 * Type guard that validates whether the given value is a valid GeoJSON FeatureCollection.
 * Checks type, structure, and that all features have valid geometries.
 */
export function isGeoJsonFeatureCollection(
	value: unknown,
): value is GeoJsonFeatureCollection {
	if (
		!isRecord(value) ||
		value.type !== "FeatureCollection" ||
		!Array.isArray(value.features)
	)
		return false;
	return value.features.every((feature: unknown) => {
		if (!isRecord(feature) || feature.type !== "Feature") return false;
		const geometry = (feature as unknown as GeoJsonFeature).geometry;
		if (geometry !== null && !isRecord(geometry)) return false;
		if (
			feature.properties !== undefined &&
			feature.properties !== null &&
			!isRecord(feature.properties)
		)
			return false;
		return geometry === null || isGeometry(geometry);
	});
}

/**
 * Validates whether the given value is a valid GeoJSON geometry object.
 * Checks that the geometry type is recognized and its coordinates conform to the spec.
 */
function isGeometry(value: unknown): value is GeoJsonGeometry {
	if (!isRecord(value)) return false;
	const positions = value.coordinates;
	switch (value.type) {
		case "Point":
			return isPosition(positions);
		case "MultiPoint":
			return (
				Array.isArray(positions) &&
				positions.length > 0 &&
				positions.every(isPosition)
			);
		case "LineString":
			return (
				Array.isArray(positions) &&
				positions.every(isPosition) &&
				positions.length >= 2
			);
		case "MultiLineString":
			return (
				Array.isArray(positions) &&
				positions.length > 0 &&
				positions.every(
					(line: unknown) =>
						Array.isArray(line) && line.length >= 2 && line.every(isPosition),
				)
			);
		case "Polygon":
			return (
				Array.isArray(positions) &&
				positions.length > 0 &&
				positions.every(isLinearRing)
			);
		case "MultiPolygon":
			return (
				Array.isArray(positions) &&
				positions.length > 0 &&
				positions.every(
					(polygon: unknown) =>
						Array.isArray(polygon) &&
						polygon.length > 0 &&
						polygon.every(isLinearRing),
				)
			);
		default:
			return false;
	}
}

/**
 * Validates that the given array is a valid GeoJSON linear ring: a closed sequence
 * of positions (first equals last) with at least 4 points.
 */
function isLinearRing(value: unknown): value is [number, number][] {
	if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition))
		return false;
	const first = value[0];
	const last = value[value.length - 1];
	return first[0] === last[0] && first[1] === last[1];
}

/**
 * Validates that the given value is a valid GeoJSON position (longitude, latitude pair).
 * Checks that coordinates are finite numbers within valid ranges (-180 to 180 for lon, -90 to 90 for lat).
 */
function isPosition(value: unknown): value is [number, number] {
	return (
		Array.isArray(value) &&
		value.length >= 2 &&
		typeof value[0] === "number" &&
		Number.isFinite(value[0]) &&
		value[0] >= -180 &&
		value[0] <= 180 &&
		typeof value[1] === "number" &&
		Number.isFinite(value[1]) &&
		value[1] >= -90 &&
		value[1] <= 90
	);
}

/**
 * Calculates the shortest distance (in meters) from a point to a polygon.
 * If the point is inside the outer ring but not inside any holes, returns 0.
 * Otherwise returns the minimum distance to any ring boundary.
 */
function polygonDistance(
	point: Pick<Trackpoint, "lat" | "lon">,
	rings: [number, number][][],
): number {
	if (rings.length === 0) return Number.POSITIVE_INFINITY;
	const insideOuter = pointInRing(point, rings[0]);
	const insideHole = rings.slice(1).some((ring) => pointInRing(point, ring));
	if (insideOuter && !insideHole) return 0;
	return minimum(rings.map((ring) => lineDistance(point, ring)));
}

/**
 * Determines whether a point is inside a closed polygon ring using the ray-casting algorithm.
 * Casts a horizontal ray from the point to the right and counts edge crossings.
 */
function pointInRing(
	point: Pick<Trackpoint, "lat" | "lon">,
	ring: [number, number][],
): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		const intersects =
			yi > point.lat !== yj > point.lat &&
			point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

/**
 * Calculates the shortest distance (in meters) from a point to a line string.
 * For a single coordinate, returns distance to that point.
 * For multiple coordinates, finds the minimum distance to any line segment.
 */
function lineDistance(
	point: Pick<Trackpoint, "lat" | "lon">,
	coordinates: [number, number][],
): number {
	if (coordinates.length === 0) return Number.POSITIVE_INFINITY;
	if (coordinates.length === 1) {
		return distanceMeters(point, {
			lon: coordinates[0][0],
			lat: coordinates[0][1],
		});
	}
	let shortest = Number.POSITIVE_INFINITY;
	for (let i = 1; i < coordinates.length; i++) {
		shortest = Math.min(
			shortest,
			pointToLineSegment(point, coordinates[i - 1], coordinates[i]),
		);
	}
	return shortest;
}

/**
 * Calculates the shortest distance from a point to a line segment [start, end].
 * Projects the point onto the line segment, clamping to the segment bounds.
 * Accounts for lat/lon distortion by scaling x and y coordinates differently.
 */
function pointToLineSegment(
	point: Pick<Trackpoint, "lat" | "lon">,
	start: [number, number],
	end: [number, number],
): number {
	const scaleX =
		((Math.cos(toRadians(point.lat)) * Math.PI) / 180) * EARTH_RADIUS_METERS;
	const scaleY = (Math.PI / 180) * EARTH_RADIUS_METERS;
	const px = point.lon * scaleX;
	const py = point.lat * scaleY;
	const sx = start[0] * scaleX;
	const sy = start[1] * scaleY;
	const ex = end[0] * scaleX;
	const ey = end[1] * scaleY;
	const dx = ex - sx;
	const dy = ey - sy;
	const lengthSquared = dx * dx + dy * dy;
	const projection =
		lengthSquared === 0
			? 0
			: Math.max(
					0,
					Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSquared),
				);
	return Math.hypot(px - (sx + projection * dx), py - (sy + projection * dy));
}

/**
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY
}

/**
 * Converts an angle from degrees to radians.
 */
function toRadians(degrees: number): number {
	return (degrees * Math.PI) / 180;
}
