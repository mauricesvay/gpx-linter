#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { applyRuleOverride, DEFAULT_CONFIG, loadConfig } from "./config";
import { evaluateRules } from "./engine";
import { isGeoJsonFeatureCollection } from "./geo";
import { parseGpx } from "./gpxParser";
import { enrichWithOsm } from "./osm";
import { createReport, formatReport } from "./reporter";
import { resolveRoads } from "./resolver";
import type {
	DataAvailability,
	DataSourceAvailability,
	GeoJsonFeatureCollection,
	LinterConfig,
	RuleDefinition,
} from "./types";
import { errorMessage } from "./utils";

export function createCli(): Command {
	const program = new Command();
	program
		.name("gpxlint")
		.description(
			"Lint GPX bike routes against configurable route-safety and quality rules.",
		)
		.version("1.0.0");

	program
		.command("check")
		.description("Check a GPX route")
		.argument("<file>", "GPX file to check")
		.option("-c, --config <file>", "YAML configuration file")
		.option("--rule <id>", "Rule to enable or disable")
		.option("--enable", "Enable the selected rule")
		.option("--disable", "Disable the selected rule")
		.option("--geojson <file>", "Roadworks GeoJSON file")
		.option("--routing <provider>", "Routing provider (overpass, offline)")
		.option("--url <url>", "Routing provider URL")
		.option("-f, --format <format>", "Report format (text, json, html)")
		.option("-o, --output <file>", "Write report to a file")
		.option("--no-cache", "Disable disk-based road-match cache")
		.action(async (file: string, options: CheckOptions) => {
			const exitCode = await runCheck(file, options);
			process.exitCode = exitCode;
		});

	program
		.command("rules")
		.description("List built-in rules")
		.command("list")
		.description("Show available built-in rules and their default state")
		.action(() => {
			for (const [id, definition] of Object.entries(loadBuiltinDefinitions())) {
				console.log(
					`${id.padEnd(20)} ${definition.enabled ? "enabled" : "disabled"}  ${definition.severity}`,
				);
			}
		});

	program
		.command("cache")
		.description("Manage the local cache")
		.command("clear")
		.description("Clear cached road matches")
		.action(async () => {
			const cacheDirectory = path.join(os.homedir(), ".cache", "gpxlint");
			try {
				await mkdir(cacheDirectory, { recursive: true });
				await Promise.all(
					["cache.json", "osm-cache.json"].map((file) =>
						writeFile(path.join(cacheDirectory, file), "{}", "utf8"),
					),
				);
				console.log("Road and OSM caches cleared.");
			} catch (error) {
				console.error(`Unable to clear cache: ${errorMessage(error)}`);
				process.exitCode = 3;
			}
		});

	return program;
}

interface CheckOptions {
	config?: string;
	rule?: string;
	enable?: boolean;
	disable?: boolean;
	geojson?: string;
	routing?: "overpass" | "offline";
	url?: string;
	format?: "text" | "json" | "html";
	output?: string;
	cache?: boolean;
}

export async function runCheck(
	file: string,
	options: CheckOptions = {},
): Promise<0 | 1 | 2 | 3> {
	try {
		if (options.enable && options.disable)
			throw new Error("Use only one of --enable or --disable");
		if (options.routing && !["overpass", "offline"].includes(options.routing)) {
			throw new Error("--routing must be overpass or offline");
		}
		if (options.format && !["text", "json", "html"].includes(options.format)) {
			throw new Error("--format must be text, json, or html");
		}
		if (options.url) {
			const url = new URL(options.url);
			if (url.protocol !== "https:" && url.protocol !== "http:")
				throw new Error("--url must be an HTTP(S) URL");
		}
		let config = await loadConfig(options.config);
		if (options.rule && (options.enable || options.disable)) {
			config = applyRuleOverride(config, options.rule, options.enable === true);
		}
		if (options.routing) {
			config.routing = {
				...config.routing,
				provider: options.routing,
			};
		}
		if (options.url) config.routing = { ...config.routing, url: options.url };

		const gpxContents = await readFile(file, "utf8");
		const parsed = parseGpx(gpxContents);
		const rules = { ...config.rules };
		if (options.geojson) {
			const roadworks = await loadGeoJson(options.geojson);
			const current: RuleDefinition = rules.roadworks ?? {
				severity: "warning",
			};
			rules.roadworks = {
				...current,
				enabled: true,
				params: {
					...current.params,
					geojson_file: path.resolve(options.geojson),
				},
				data: roadworks,
			};
		} else if (rules.roadworks?.enabled) {
			const geojsonPath = rules.roadworks.params?.geojson_file;
			if (typeof geojsonPath === "string") {
				try {
					rules.roadworks = {
						...rules.roadworks,
						data: await loadGeoJson(geojsonPath),
					};
				} catch (error) {
					console.error(`Roadworks data unavailable: ${errorMessage(error)}`);
				}
			}
		}
		config = { ...config, rules };

		const needsMatching =
			enabled(config, "contraflow_bike") || enabled(config, "off_road");
		const needsOsm = enabled(config, "contraflow_bike");
		const provider = config.routing?.provider ?? "overpass";
		const inlineOsm = provider === "overpass";
		const matching = needsMatching
			? await resolveRoads(parsed.points, {
					provider,
					url: config.routing?.url,
					overpassUrl: config.routing?.overpass_url,
					cache: options.cache !== false && config.routing?.cache !== false,
					cacheDir: config.routing?.cache_dir,
				})
			: null;
		if (matching?.cacheError) console.error(matching.cacheError);
		for (const providerError of matching?.providerErrors ?? [])
			console.error(`Routing provider unavailable: ${providerError}`);

		const osm =
			needsOsm && matching && !inlineOsm
				? await enrichWithOsm(parsed.points, matching.matches, {
						url: config.routing?.overpass_url,
						cache: options.cache !== false && config.routing?.cache !== false,
						cacheDir: config.routing?.cache_dir,
					})
				: null;
		if (osm?.cacheError) console.error(osm.cacheError);
		for (const providerError of osm?.providerErrors ?? [])
			console.error(`OSM enrichment unavailable: ${providerError}`);
		const matches = osm?.matches ?? matching?.matches;

		const results = evaluateRules(parsed.points, {
			rules: config.rules,
			roadMatching: matching?.availability,
			matches,
			roadMatches: matching?.matches,
			routeContext: config.route_context,
		});
		const gpxNeedsElevation = enabled(config, "max_slope");
		const missingElevations = parsed.points.filter(
			(point) => point.ele === null,
		).length;
		const gpxAvailability: DataSourceAvailability = {
			status:
				gpxNeedsElevation && missingElevations > 0 ? "partial" : "complete",
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
			: isFeatureCollection(config.rules.roadworks?.data)
				? {
						status: "complete",
						source: "geojson",
						requestedItems: config.rules.roadworks.data.features.length,
						availableItems: config.rules.roadworks.data.features.length,
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
			roadMatching: needsMatching
				? (matching?.availability ?? {
						status: "unavailable",
						source: config.routing?.provider ?? "overpass",
						requestedItems: parsed.points.length,
						availableItems: 0,
					})
				: notRequired("routing"),
			osm:
				needsOsm || (inlineOsm && needsMatching)
					? (osm?.availability ??
						matching?.availability ?? {
							status: "unavailable",
							source: config.routing?.overpass_url ?? "overpass",
							requestedItems: parsed.points.length,
							availableItems: 0,
							message: inlineOsm
								? "OSM data was not fetched (no road matching needed)."
								: "OSM enrichment was not run.",
						})
					: notRequired("overpass"),
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
		const report = createReport({
			routeName: parsed.metadata.gpxName ?? path.basename(file),
			results,
			availability,
			cache: {
				hits: (matching?.cache.hits ?? 0) + (osm?.cache.hits ?? 0),
				misses: (matching?.cache.misses ?? 0) + (osm?.cache.misses ?? 0),
			},
			trackCoords: parsed.points.map((p) => ({ lat: p.lat, lon: p.lon })),
		});
		const output = formatReport(
			report,
			options.format ?? config.reporting?.format ?? "text",
			options.output && config.reporting?.color === "auto"
				? "never"
				: (config.reporting?.color ?? "auto"),
		);
		if (options.output) await writeFile(options.output, output, "utf8");
		else process.stdout.write(output);
		return report.exitCode;
	} catch (error) {
		console.error(`gpxlint: ${errorMessage(error)}`);
		return 3;
	}
}

function loadBuiltinDefinitions(): LinterConfig["rules"] {
	return DEFAULT_CONFIG.rules;
}

async function loadGeoJson(file: string): Promise<GeoJsonFeatureCollection> {
	let contents: string;
	try {
		contents = await readFile(file, "utf8");
	} catch (error) {
		throw new Error(
			`Unable to read roadworks GeoJSON "${file}": ${errorMessage(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new Error(
			`Invalid roadworks GeoJSON "${file}": ${errorMessage(error)}`,
		);
	}
	if (!isFeatureCollection(parsed))
		throw new Error(
			`Roadworks file "${file}" is not a valid GeoJSON FeatureCollection`,
		);
	return parsed;
}

function isFeatureCollection(
	value: unknown,
): value is GeoJsonFeatureCollection {
	return isGeoJsonFeatureCollection(value);
}

function enabled(config: LinterConfig, ruleId: string): boolean {
	return (
		config.rules[ruleId]?.enabled !== false &&
		config.rules[ruleId] !== undefined
	);
}

if (require.main === module) {
	createCli()
		.parseAsync(process.argv)
		.catch((error) => {
			console.error(`gpxlint: ${errorMessage(error)}`);
			process.exitCode = 3;
		});
}
