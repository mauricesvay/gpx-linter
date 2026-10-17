import { XMLParser, XMLValidator } from "fast-xml-parser";
import { bearingDegrees, distanceMeters } from "./geo";
import type {
	GpxSegment,
	GpxTrack,
	ParsedGpx,
	RouteMetadata,
	Trackpoint,
} from "./types";
import { isRecord } from "./utils";

type XmlRecord = Record<string, unknown>;

export function parseGpx(xml: string): ParsedGpx {
	const validation = XMLValidator.validate(xml);
	if (validation !== true)
		throw new Error(`Invalid GPX XML: ${validation.err.msg}`);

	const parsed = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
		parseTagValue: true,
		trimValues: true,
	}).parse(xml) as XmlRecord;
	const root = parsed.gpx;
	if (!isRecord(root))
		throw new Error("Invalid GPX document: missing <gpx> root");

	const rawTracks = asArray(root.trk);
	const tracks: GpxTrack[] = [];
	const points: Trackpoint[] = [];
	let segmentId = 0;
	let distanceFromStart = 0;
	let earliestTime: Date | null = null;
	let previousInSegment: Trackpoint | null = null;

	for (const rawTrack of rawTracks) {
		if (!isRecord(rawTrack)) continue;
		const segments: GpxSegment[] = [];
		for (const rawSegment of asArray(rawTrack.trkseg)) {
			if (!isRecord(rawSegment)) continue;
			const segmentPoints: Trackpoint[] = [];
			for (const rawPoint of asArray(rawSegment.trkpt)) {
				if (!isRecord(rawPoint)) continue;
				const lat = numericAttribute(rawPoint, "lat");
				const lon = numericAttribute(rawPoint, "lon");
				if (
					lat === null ||
					lon === null ||
					lat < -90 ||
					lat > 90 ||
					lon < -180 ||
					lon > 180
				) {
					throw new Error(
						"Invalid GPX coordinate: latitude and longitude must be within valid ranges",
					);
				}
				const eleValue = rawPoint.ele;
				const ele =
					typeof eleValue === "number" && Number.isFinite(eleValue)
						? eleValue
						: typeof eleValue === "string" &&
								eleValue.trim() !== "" &&
								Number.isFinite(Number(eleValue))
							? Number(eleValue)
							: null;
				const timeValue = rawPoint.time;
				const time =
					typeof timeValue === "string" && !Number.isNaN(Date.parse(timeValue))
						? new Date(timeValue)
						: null;
				if (time && (!earliestTime || time < earliestTime)) earliestTime = time;

				const point: Trackpoint = {
					lat,
					lon,
					ele,
					time,
					distanceFromStart,
					bearing: null,
					index: points.length,
					segmentId,
					distanceTo: (other) => distanceMeters(point, other),
				};
				if (previousInSegment) {
					distanceFromStart += distanceMeters(previousInSegment, point);
					point.distanceFromStart = distanceFromStart;
					previousInSegment.bearing = bearingDegrees(previousInSegment, point);
				}
				points.push(point);
				segmentPoints.push(point);
				previousInSegment = point;
			}
			if (segmentPoints.length > 0) segments.push({ points: segmentPoints });
			segmentId++;
			previousInSegment = null;
		}
		if (segments.length > 0) {
			const name = typeof rawTrack.name === "string" ? rawTrack.name : null;
			tracks.push({ name, segments });
		}
	}

	if (points.length === 0) throw new Error("GPX contains no trackpoints");
	const metadataElement = isRecord(root.metadata) ? root.metadata : {};
	const gpxName =
		typeof metadataElement.name === "string" ? metadataElement.name : null;
	const creator =
		typeof root["@_creator"] === "string" ? root["@_creator"] : null;
	const totalElevationGain = calculateElevationGain(points);
	const metadata: RouteMetadata = {
		gpxName,
		gpxCreator: creator,
		trackDate: earliestTime,
		totalPoints: points.length,
		totalDistance: distanceFromStart,
		totalElevationGain,
	};
	return { tracks, points, metadata };
}

export function parseGpxFile(contents: string): ParsedGpx {
	return parseGpx(contents);
}

function calculateElevationGain(points: Trackpoint[]): number {
	let gain = 0;
	let previous: Trackpoint | null = null;
	for (const point of points) {
		if (point.segmentId !== previous?.segmentId) previous = null;
		if (
			previous?.ele !== null &&
			previous?.ele !== undefined &&
			point.ele !== null
		) {
			gain += Math.max(0, point.ele - previous.ele);
		}
		previous = point;
	}
	return gain;
}

function numericAttribute(point: XmlRecord, name: string): number | null {
	const value = point[`@_${name}`];
	if (typeof value !== "number" && typeof value !== "string") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function asArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}
