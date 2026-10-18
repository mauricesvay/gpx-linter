import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyRuleOverride, loadConfig } from "./config";
import { DEFAULT_MAX_TRACK_POINTS } from "./constants";
import { evaluateRules } from "./engine";
import { parseGpx } from "./gpxParser";
import { enrichWithOsm } from "./osm";
import { createReport, formatReport } from "./reporter";
import { resolveRoads } from "./resolver/index";
import type {
	DataAvailability,
	DataSourceAvailability,
	LinterConfig,
	LintReport,
	Trackpoint,
} from "./types";

// ── Service interfaces (DI boundaries) ──────────────────

/** Resolves trackpoints to road geometry via Overpass or offline backend. */
export interface RouteResolver {
	resolve(
		points: Trackpoint[],
		options: {
			provider?: "overpass" | "offline";
			url?: string;
			overpassUrl?: string;
			cache?: boolean;
			cacheDir?: string;
			fetcher?: typeof fetch;
			fetchOsmWays?: boolean;
		},
	): Promise<import("./resolver").ResolutionResult>;
}

/** Enriches matched roads with OSM tag data for contraflow detection. */
export interface OsmEnricher {
	enrich(
		points: Trackpoint[],
		matches: import("./types").MatchResult[],
		options: {
			url?: string;
			cache?: boolean;
			cacheDir?: string;
		},
	): Promise<import("./osm").OsmEnrichmentResult>;
}

/** Reads and writes files for GPX parsing and report output. */
export interface FileSystem {
	readFile(path: string, encoding: "utf8"): Promise<string>;
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

// ── Default production implementations ──────────────────

const defaultResolver: RouteResolver = {
	resolve: (points, options) => resolveRoads(points, options),
};

const defaultEnricher: OsmEnricher = {
	enrich: (points, matches, options) => enrichWithOsm(points, matches, options),
};

const defaultFs: FileSystem = {
	readFile: (p: string) => readFile(p, "utf8"),
	writeFile: (p: string, d: string) => writeFile(p, d, "utf8"),
};

// ── Public options ──────────────────────────────────────

export interface LintOptions {
	file: string;
	config?: LinterConfig;
	rule?: string;
	enable?: boolean;
	disable?: boolean;
	routing?: "overpass" | "offline";
	url?: string;
	format?: "text" | "json" | "html";
	output?: string;
	cache?: boolean;
	maxPoints?: number;
	/** Optional dependency injection for testing / backend swapping. */
	deps?: {
		resolver?: RouteResolver;
		enricher?: OsmEnricher;
		fs?: FileSystem;
	};
}

export interface LintResult {
	report: LintReport;
	exitCode: 0 | 1 | 2 | 3;
}

// ── Helpers ──────────────────────────────────────────────

function enabled(config: LinterConfig, ruleId: string): boolean {
	return (
		config.rules[ruleId]?.enabled !== false &&
		config.rules[ruleId] !== undefined
	);
}

// ── Core linting pipeline ────────────────────────────────

/**
 * Core linting pipeline.  Orchestrates config loading, GPX parsing,
 * road matching, OSM enrichment, rule evaluation, and report generation.
 *
 * Accepts optional `deps` for dependency injection. When provided,
 * tests can inject fake resolvers and cache stores. The CLI uses
 * production defaults.
 */
export async function runLinter(options: LintOptions): Promise<LintResult> {
	const {
		file,
		config: userConfig,
		rule,
		enable,
		disable,
		routing,
		url,
		format,
		output,
		cache = true,
		deps,
	} = options;

	const resolver = deps?.resolver ?? defaultResolver;
	const enricher = deps?.enricher ?? defaultEnricher;
	const fs = deps?.fs ?? defaultFs;

	// Validate options
	if (enable && disable)
		throw new Error("Use only one of --enable or --disable");
	if (routing && !["overpass", "offline"].includes(routing)) {
		throw new Error("--routing must be overpass or offline");
	}
	if (format && !["text", "json", "html"].includes(format)) {
		throw new Error("--format must be text, json, or html");
	}
	if (url) {
		const urlObj = new URL(url);
		if (urlObj.protocol !== "https:" && urlObj.protocol !== "http:")
			throw new Error("--url must be an HTTP(S) URL");
	}

	// Load and apply config overrides
	let config = userConfig ?? (await loadConfig(""));
	if (rule && (enable || disable)) {
		config = applyRuleOverride(config, rule, enable === true);
	}
	if (routing) {
		config = {
			...config,
			routing: { ...config.routing, provider: routing },
		};
	}
	if (url) {
		config = { ...config, routing: { ...config.routing, url } };
	}
	const outputFormat = format ?? config.reporting?.format ?? "text";

	// Parse GPX
	const gpxContents = await fs.readFile(file, "utf8");
	const parsed = parseGpx(gpxContents);

	// Enforce max-points limit
	const maxPoints = options.maxPoints ?? DEFAULT_MAX_TRACK_POINTS;
	if (parsed.points.length > maxPoints) {
		throw new Error(
			`GPX contains ${parsed.points.length} points; maximum supported is ${maxPoints}. Use --max-points to increase the limit or split the file.`,
		);
	}

	const rules = { ...config.rules };
	config = { ...config, rules };

	// Road matching (always run — provides data for all rules)
	const needsOsmWays = enabled(config, "bike_lane_no_same_direction_car_lane");
	const matching = await resolver.resolve(parsed.points, {
		provider: routing ?? config.routing?.provider ?? "overpass",
		url: config.routing?.url,
		overpassUrl: config.routing?.overpass_url,
		cache: cache && config.routing?.cache !== false,
		cacheDir: config.routing?.cache_dir,
		fetchOsmWays: needsOsmWays,
	});

	// Print matching status to stderr
	const cacheInfo =
		matching.cache.hits > 0 || matching.cache.misses > 0
			? ` (cache: ${matching.cache.hits} hits, ${matching.cache.misses} misses)`
			: "";
	console.error(
		`[overpass] Road matching: ${matching.availability.status} — ${matching.availability.availableItems}/${matching.availability.requestedItems} points matched${cacheInfo}`,
	);
	if (matching.availability.message)
		console.error(`[overpass]   ${matching.availability.message}`);
	if (matching.cacheError) console.error(`[overpass]   ${matching.cacheError}`);
	for (const providerError of matching.providerErrors)
		console.error(
			`[overpass]   Routing provider unavailable: ${providerError}`,
		);
	if (matching.osmWaysAvailability) {
		console.error(
			`[overpass] OSM way data: ${matching.osmWaysAvailability.status} — ${matching.osmWaysAvailability.availableItems}/${matching.osmWaysAvailability.requestedItems} chunks available`,
		);
		if (matching.osmWaysAvailability.message)
			console.error(`[overpass]   ${matching.osmWaysAvailability.message}`);
	}
	if (matching.osmWaysCacheError)
		console.error(`[overpass]   ${matching.osmWaysCacheError}`);
	for (const osmError of matching.osmWaysErrors ?? [])
		console.error(`[overpass]   OSM way fetch unavailable: ${osmError}`);

	// OSM enrichment (for offline routing — overpass fetches inline)
	const provider = config.routing?.provider ?? "overpass";
	const inlineOsm = provider === "overpass";
	const osm =
		matching && !inlineOsm
			? await enricher.enrich(parsed.points, matching.matches, {
					url: config.routing?.overpass_url,
					cache: cache && config.routing?.cache !== false,
					cacheDir: config.routing?.cache_dir,
				})
			: null;

	// Print OSM status to stderr
	if (osm) {
		const cacheInfo =
			osm.cache.hits > 0 || osm.cache.misses > 0
				? ` (cache: ${osm.cache.hits} hits, ${osm.cache.misses} misses)`
				: "";
		console.error(
			`[overpass] OSM enrichment: ${osm.availability.status} — ${osm.availability.availableItems}/${osm.availability.requestedItems} points enriched${cacheInfo}`,
		);
		if (osm.availability.message)
			console.error(`[overpass]   ${osm.availability.message}`);
		if (osm.cacheError) console.error(`[overpass]   ${osm.cacheError}`);
		for (const providerError of osm.providerErrors)
			console.error(`[overpass]   OSM provider unavailable: ${providerError}`);
	}

	// Build matched route (for HTML debug visualization)
	const routeMatches = osm?.matches ?? matching?.matches;
	const routeOsmWays =
		osm?.osmWays ?? (inlineOsm && matching ? matching.osmWays : undefined);
	const matchedRoadIds = routeMatches?.map((m) => m?.roadId ?? null);
	const matchedHighway = routeMatches?.map((m) => m?.tags?.highway ?? null);
	const matchedStatus = routeMatches?.map((m) => m?.status ?? null);

	const results = await evaluateRules(parsed.points, {
		rules: config.rules,
		roadMatching: matching?.availability,
		matches: routeMatches,
		roadMatches: matching?.matches,
		routeContext: config.route_context,
		osmWays: routeOsmWays,
		osmWaysAvailability: osm?.availability ?? matching?.osmWaysAvailability,
	});

	// Build data availability
	const gpxNeedsElevation = enabled(config, "max_slope");
	const missingElevations = parsed.points.filter(
		(point) => point.ele === null,
	).length;
	const gpxAvailability: DataSourceAvailability = {
		status: gpxNeedsElevation && missingElevations > 0 ? "partial" : "complete",
		source: "gpx",
		requestedItems: parsed.points.length,
		availableItems: gpxNeedsElevation
			? parsed.points.length - missingElevations
			: parsed.points.length,
		message:
			gpxNeedsElevation && missingElevations > 0
				? `${missingElevations} point(s) lack elevation required by max_slope.`
				: undefined,
	};
	const notRequired = (source: string): DataSourceAvailability => ({
		status: "not_required",
		source,
		requestedItems: 0,
		availableItems: 0,
	});
	const roadworksAvailability: DataSourceAvailability = !enabled(
		config,
		"roadworks",
	)
		? notRequired("geojson")
		: config.rules.roadworks?.params?.geojson_file
			? {
					status: "complete",
					source: "geojson",
					requestedItems: parsed.points.length,
					availableItems: parsed.points.length,
				}
			: {
					status: "unavailable",
					source: "geojson",
					requestedItems: parsed.points.length,
					availableItems: 0,
					message:
						"Roadworks rule is enabled but no valid GeoJSON data is available.",
				};

	const availability: DataAvailability = {
		gpx: gpxAvailability,
		roadMatching: matching?.availability ?? {
			status: "unavailable",
			source: config.routing?.provider ?? "overpass",
			requestedItems: parsed.points.length,
			availableItems: 0,
		},
		osm: inlineOsm
			? (osm?.availability ??
				matching?.osmWaysAvailability ??
				matching?.availability ?? {
					status: "unavailable",
					source: config.routing?.overpass_url ?? "overpass",
					requestedItems: parsed.points.length,
					availableItems: 0,
					message: "OSM enrichment was not run (inline overpass).",
				})
			: (osm?.availability ?? notRequired("overpass")),
		roadworks: roadworksAvailability,
		incomplete: false,
	};
	availability.incomplete =
		[
			availability.gpx,
			availability.roadMatching,
			availability.osm,
			availability.roadworks,
		].some(
			(source) =>
				source.status === "partial" || source.status === "unavailable",
		) || results.some((result) => result.status === "unknown");

	// Create and format report
	const enabledRules = new Set(
		Object.keys(config.rules).filter((id) => enabled(config, id)),
	);
	const report = createReport({
		routeName: parsed.metadata.gpxName ?? path.basename(file),
		results,
		availability,
		enabledRules,
		cache: {
			hits:
				(matching?.cache.hits ?? 0) +
				(matching?.osmWaysCache?.hits ?? 0) +
				(osm?.cache.hits ?? 0),
			misses:
				(matching?.cache.misses ?? 0) +
				(matching?.osmWaysCache?.misses ?? 0) +
				(osm?.cache.misses ?? 0),
		},
		trackCoords: parsed.points.map((p) => ({
			lat: p.lat,
			lon: p.lon,
			distanceFromStart: p.distanceFromStart,
		})),
		matchedRoadIds: matchedRoadIds,
		matchedHighway: matchedHighway,
		matchedStatus: matchedStatus,
		routeStats: {
			totalDistance: parsed.metadata.totalDistance,
			totalElevationGain: parsed.metadata.totalElevationGain,
			maxGradient: parsed.metadata.maxGradient,
		},
	});

	const outputContent = await formatReport(
		report,
		outputFormat,
		output && config.reporting?.color === "auto"
			? "never"
			: (config.reporting?.color ?? "auto"),
	);
	if (output) await fs.writeFile(output, outputContent, "utf8");
	else process.stdout.write(outputContent);

	return { report, exitCode: report.exitCode };
}
