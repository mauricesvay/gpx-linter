#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "./config";
import { getAllRuleMetadata } from "./engine";
import type { LinterConfig } from "./types";
import { runLinter } from "./linter";
import { errorMessage } from "./utils";

import { CLI_VERSION, DEFAULT_MAX_TRACK_POINTS } from "./constants";

export function createCli(): Command {
	const program = new Command();
	program
		.name("gpxlint")
		.description(
			"Lint GPX bike routes against configurable route-safety and quality rules.",
		)
		.version(CLI_VERSION);

	program
		.command("check")
		.description("Check a GPX route")
		.argument("<file...>", "GPX file(s) to check")
		.option("-c, --config <file>", "YAML configuration file")
		.option("--dry-run", "Validate config only, skip GPX parsing")
		.option(
			"--max-points <n>",
			`Maximum trackpoints per file (default: ${DEFAULT_MAX_TRACK_POINTS})`,
			(value: string) => {
				const parsed = parseInt(value, 10);
				if (isNaN(parsed)) {
					throw new Error(
						`--max-points must be a valid integer, got "${value}"`,
					);
				}
				return parsed;
			},
		)
		.option("--rule <id>", "Rule to enable or disable")
		.option("--enable", "Enable the selected rule")
		.option("--disable", "Disable the selected rule")
		.option("--routing <provider>", "Routing provider (overpass, offline)")
		.option("--url <url>", "Routing provider URL")
		.option("-f, --format <format>", "Report format (text, json, html)")
		.option("-o, --output <file>", "Write report to a file")
		.option("--no-cache", "Disable disk-based road-match cache")
		.action(async (files: string[], options: CheckOptions) => {
			const exitCode = await runCheck(files, options);
			process.exitCode = exitCode;
		});

	program
		.command("rules")
		.description("List built-in rules")
		.command("list")
		.description("Show available built-in rules and their default state")
		.action(() => {
			const metadata = getAllRuleMetadata();
			for (const [id, meta] of Object.entries(metadata)) {
				const enabled = meta.enabledByDefault ? "enabled" : "disabled";
				console.log(
					`${id.padEnd(20)} ${enabled.padEnd(8)}  ${meta.defaultSeverity}`,
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
	dryRun?: boolean;
	maxPoints?: number;
	rule?: string;
	enable?: boolean;
	disable?: boolean;
	routing?: "overpass" | "offline";
	url?: string;
	format?: "text" | "json" | "html";
	output?: string;
	cache?: boolean;
}

export async function runCheck(
	files: string[],
	options: CheckOptions = {},
): Promise<0 | 1 | 2 | 3> {
	if (files.length === 0) {
		console.error(
			"gpxlint: no files specified. Usage: gpxlint check <file...>",
		);
		return 3;
	}

	try {
		// Load and validate config
		const userConfig = options.config
			? await loadConfig(options.config)
			: undefined;

		// Dry-run: validate config only, skip GPX parsing
		if (options.dryRun) {
			if (userConfig) {
				const ruleList = Object.entries(userConfig.rules)
					.map(
						([id, def]) =>
							`  ${id}: ${def.enabled ? "enabled" : "disabled"} (${def.severity ?? "info"})`,
					)
					.join("\n");
				console.log(
					`Config valid. Rules (${Object.keys(userConfig.rules).length}):`,
				);
				console.log(ruleList);
			} else {
				console.log("Config valid (defaults).");
			}
			return 0;
		}

		// Validate max-points
		const maxPoints = options.maxPoints ?? DEFAULT_MAX_TRACK_POINTS;
		if (maxPoints < 1) {
			console.error("gpxlint: --max-points must be a positive integer");
			return 3;
		}

		let finalExitCode: 0 | 1 | 2 | 3 = 0;
		const allResults: Array<{ file: string; exitCode: 0 | 1 | 2 | 3 }> = [];

		for (const file of files) {
			const result = await runSingleFile(file, userConfig, {
				...options,
				maxPoints,
			});
			allResults.push(result);
			if (result.exitCode > finalExitCode) {
				finalExitCode = result.exitCode;
			}
		}

		// Print summary for multi-file
		if (allResults.length > 1) {
			const summary = allResults
				.map((r) => `  ${r.file}: exit ${r.exitCode}`)
				.join("\n");
			console.error(`\nMulti-file summary:\n${summary}`);
		}

		return finalExitCode;
	} catch (error) {
		console.error(`gpxlint: ${errorMessage(error)}`);
		return 3;
	}
}

async function runSingleFile(
	file: string,
	userConfig: LinterConfig | undefined,
	options: CheckOptions & { maxPoints: number },
): Promise<{ file: string; exitCode: 0 | 1 | 2 | 3 }> {
	try {
		const { exitCode } = await runLinter({
			file,
			config: userConfig,
			rule: options.rule,
			enable: options.enable,
			disable: options.disable,
			routing: options.routing,
			url: options.url,
			format: options.format,
			output: options.output,
			cache: options.cache !== false,
			maxPoints: options.maxPoints,
		});
		return { file, exitCode };
	} catch (error) {
		console.error(`gpxlint: ${errorMessage(error)}`);
		return { file: file, exitCode: 3 };
	}
}

if (require.main === module) {
	createCli()
		.parseAsync(process.argv)
		.catch((error) => {
			console.error(`gpxlint: ${errorMessage(error)}`);
			process.exitCode = 3;
		});
}
