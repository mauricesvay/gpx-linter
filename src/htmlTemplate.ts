import * as fs from "node:fs";
import * as path from "node:path";
import * as Handlebars from "handlebars";
import type {
	LintReport,
	RouteMetadata,
	RuleResult,
	TrackCoordinate,
} from "./types";

const LEAFLET_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const PMTILES_URL = "https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js";
const GEOMETRYUTIL_URL =
	"https://raw.githubusercontent.com/makinacorpus/leaflet.geometryutil/master/src/leaflet.geometryutil.js";
const DISTANCE_MARKER_URL =
	"https://raw.githubusercontent.com/adoroszlai/leaflet-distance-markers/master/leaflet-distance-marker.js";
const DISTANCE_MARKER_CSS_URL =
	"https://raw.githubusercontent.com/adoroszlai/leaflet-distance-markers/master/leaflet-distance-marker.css";

const TEMPLATES_DIR = path.join(__dirname, "templates");

interface ResultRange {
	ruleId: string;
	enabled?: boolean;
	status: RuleResult["status"];
	severity: RuleResult["severity"];
	confidence: RuleResult["confidence"];
	message: string;
	source?: Record<string, unknown>;
	evidence?: Record<string, unknown>;
	pointIndex?: number;
	startIndex: number;
	endIndex: number;
	startLat?: number;
	startLon?: number;
	endLat?: number;
	endLon?: number;
	distanceFromStart?: string;
	distanceToEnd?: string;
}

function groupContiguousResults(
	results: RuleResult[],
	trackCoords?: TrackCoordinate[],
): ResultRange[] {
	const indexed = results
		.filter((r) => r.pointIndex !== undefined)
		.sort((a, b) => (a.pointIndex ?? 0) - (b.pointIndex ?? 0));

	if (indexed.length === 0) return [];

	const ranges: ResultRange[] = [];
	let current: ResultRange | null = null;

	for (const r of indexed) {
		const idx = r.pointIndex!;

		if (
			!current ||
			current.status !== r.status ||
			current.severity !== r.severity ||
			current.ruleId !== r.ruleId ||
			current.endIndex !== idx - 1
		) {
			if (current) ranges.push(current);
			current = {
				ruleId: r.ruleId,
				status: r.status,
				severity: r.severity,
				confidence: r.confidence,
				message: r.message,
				source: r.source,
				evidence: r.evidence,
				pointIndex: r.pointIndex,
				startIndex: idx,
				endIndex: idx,
				startLat: r.lat,
				startLon: r.lon,
				endLat: r.lat,
				endLon: r.lon,
		};
		} else {
			current.endIndex = idx;
			current.endLat = r.lat;
			current.endLon = r.lon;
		}
	}
	if (current) ranges.push(current);

	// Compute distanceFromStart and distanceToEnd for each range
	if (trackCoords) {
		for (const r of ranges) {
			if (trackCoords[r.startIndex]) {
				r.distanceFromStart = km(trackCoords[r.startIndex].distanceFromStart);
			}
			if (r.endIndex !== r.startIndex && trackCoords[r.endIndex]) {
				r.distanceToEnd = km(trackCoords[r.endIndex].distanceFromStart);
			}
		}
	}

	return ranges;
}

function km(distanceMeters: number): string {
	return (distanceMeters / 1000).toFixed(2);
}

async function fetchScript(url: string): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
	return res.text();
}

let _scriptsPromise: Promise<{ js: string; css: string }> | null = null;

async function getPlugins(): Promise<{ js: string; css: string }> {
	if (!_scriptsPromise) {
		_scriptsPromise = Promise.all([
			fetchScript(GEOMETRYUTIL_URL),
			fetchScript(DISTANCE_MARKER_URL),
			fetchScript(DISTANCE_MARKER_CSS_URL),
		]).then(([geometryutil, distanceMarker, css]) => ({
			js: `<script>${geometryutil}</script>\n<script>${distanceMarker}</script>`,
			css: `<style>${css}</style>`,
		}));
	}
	return _scriptsPromise;
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character]!,
	);
}

// ── Handlebars setup ──────────────────────────────────

Handlebars.registerHelper("km", (meters: number) => km(meters));
Handlebars.registerHelper("escapeHtml", escapeHtml);
Handlebars.registerHelper("toUpperCase", (str: string) => str.toUpperCase());

// Load partials from files
const findingsTemplate = fs.readFileSync(
	path.join(TEMPLATES_DIR, "partials", "findings.hbs"),
	"utf-8",
);
Handlebars.registerPartial("findings", findingsTemplate);

const statusesTemplate = fs.readFileSync(
	path.join(TEMPLATES_DIR, "partials", "statuses.hbs"),
	"utf-8",
);
Handlebars.registerPartial("statuses", statusesTemplate);

// Compile main templates
const simpleTemplate = Handlebars.compile(
	fs.readFileSync(path.join(TEMPLATES_DIR, "simple.hbs"), "utf-8"),
);
const mapTemplate = Handlebars.compile(
	fs.readFileSync(path.join(TEMPLATES_DIR, "map.hbs"), "utf-8"),
);

// ── Report generation ─────────────────────────────────

export interface HtmlContext {
	routeName: string;
	errorCount: string;
	warningCount: string;
	infoCount: string;
	exitCode: string;
	routeStats?: Pick<RouteMetadata, "totalDistance" | "totalElevationGain" | "maxGradient">;
	distance?: string;
	elevGain?: string;
	maxGrad?: string;
	trackCoords?: TrackCoordinate[];
	matchedStatus?: (string | null)[];
	matchedHighway?: (string | null)[];
	findingsWithDistance?: Array<{
		lat: number;
		lon: number;
		distanceFromStart: number | null;
		ruleId: string;
		status: string;
		severity: string;
		message: string;
		evidence?: Record<string, unknown>;
	}>;
	rangeSegmentsJson?: string;
	trackJson?: string;
	pointCount?: string;
	markerCount?: string;
	pluginsHtml?: string;
	statusesHtml?: AvailabilityEntry[];
	matchStatusesJson?: string;
	matchHighwaysJson?: string;
	findingsJson?: string;
	ranges?: ResultRange[];
	rules?: LintReport["rules"];
}

interface AvailabilityEntry {
	key: string;
	status: string;
	availableItems: number;
	requestedItems: number;
	message?: string;
}

function buildStatusesHtml(
	availability: LintReport["availability"],
): AvailabilityEntry[] {
	return Object.entries(availability)
		.filter(([key]) => key !== "incomplete")
		.map(([key, item]) => ({
			key,
			status: item.status,
			availableItems: item.availableItems,
			requestedItems: item.requestedItems,
			message: item.message,
		}));
}

export async function formatHtml(report: LintReport): Promise<string> {
	const trackCoords = report.trackCoords || [];
	const ranges = groupContiguousResults(report.results, trackCoords);
	const allRules = report.rules ?? {};
	// Attach enabled status to each range
	for (const r of ranges) {
		const ruleInfo = allRules[r.ruleId];
		if (ruleInfo) r.enabled = ruleInfo.enabled;
	}
	const findingsWithCoords = report.results.filter(
		(r) => r.status !== "unknown" && r.lat !== undefined && r.lon !== undefined,
	);

	const stats = report.routeStats;
	const statusesHtml = buildStatusesHtml(report.availability);

	const baseVars: HtmlContext = {
		routeName: escapeHtml(report.routeName),
		errorCount: String(report.summary.severity.error),
		warningCount: String(report.summary.severity.warning),
		infoCount: String(report.summary.severity.info),
		exitCode: String(report.exitCode),
	};

	if (stats) {
		baseVars.routeStats = stats;
		baseVars.distance = km(stats.totalDistance);
		baseVars.elevGain = stats.totalElevationGain.toFixed(0);
		baseVars.maxGrad = stats.maxGradient.toFixed(1);
	}

	// Simple report (no map)
	if (trackCoords.length === 0) {
		const context: HtmlContext = {
			...baseVars,
			statusesHtml,
			ranges,
		};
		return simpleTemplate(context);
	}

	// Map report
	const { js, css } = await getPlugins();
	const pluginsHtml =
		`<link rel="stylesheet" href="${LEAFLET_CSS_URL}" />\n<script src="${LEAFLET_URL}"></script>\n${js}\n<script src="${PMTILES_URL}"></script>\n${css}`;

	// Escape JSON for embedding in <script> blocks
	const escapeJson = (val: unknown) =>
		JSON.stringify(val).replace(/<\/(script)/gi, "<\\/$1");

	const context: HtmlContext = {
		...baseVars,
		pluginsHtml,
		statusesHtml,
		rules: report.rules,
		ranges,
		pointCount: String(trackCoords.length),
		markerCount: String(findingsWithCoords.length),
		trackJson: escapeJson(trackCoords.map((c) => [c.lat, c.lon])),
		matchStatusesJson: escapeJson(report.matchedStatus || []),
		matchHighwaysJson: escapeJson(report.matchedHighway || []),
		findingsJson: escapeJson(
			findingsWithCoords.map((f) => {
				const idx = trackCoords.findIndex(
					(c) =>
						Math.abs(c.lat - f.lat!) < 0.0001 &&
						Math.abs(c.lon - f.lon!) < 0.0001,
				);
				return {
					lat: f.lat!,
					lon: f.lon!,
					distanceFromStart: idx >= 0 ? trackCoords[idx].distanceFromStart : null,
					ruleId: f.ruleId,
					status: f.status,
					severity: f.severity,
					message: f.message,
					evidence: f.evidence,
				};
			}),
		),
		rangeSegmentsJson: escapeJson(
			ranges
				.filter(
					(r) =>
						r.startLat !== undefined &&
						r.endLat !== undefined &&
						r.endIndex !== r.startIndex,
				)
				.map((r) => ({
					ruleId: r.ruleId,
					status: r.status,
					severity: r.severity,
					message: r.message,
					start: [r.startLat!, r.startLon!] as [number, number],
					end: [r.endLat!, r.endLon!] as [number, number],
				})),
		),
	};

	return mapTemplate(context);
}
