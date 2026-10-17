import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("configuration", () => {
	it("merges rule parameters while honoring enabled and severity overrides", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-config-"));
		directories.push(directory);
		const configFile = path.join(directory, "gpxlint.yml");
		await writeFile(
			configFile,
			`rules:
  max_slope:
    enabled: false
    severity: warning
    params:
      max_percent: 7
`,
		);
		const config = await loadConfig(configFile);

		expect(config.rules.max_slope).toMatchObject({
			enabled: false,
			severity: "warning",
			params: { max_percent: 7 },
		});
		expect(config.rules.sharp_turn.enabled).toBe(false);
	});

	it("rejects invalid rule severity and malformed configuration values", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-config-"));
		directories.push(directory);
		const configFile = path.join(directory, "gpxlint.yml");
		await writeFile(
			configFile,
			`rules:
  max_slope:
    severity: fatal
`,
		);
		await expect(loadConfig(configFile)).rejects.toThrow(/enum|severity/i);
	});

	it("selects the alternate provider when only a primary provider is configured", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-config-"));
		directories.push(directory);
		const configFile = path.join(directory, "gpxlint.yml");
		await writeFile(
			configFile,
			`routing:
  provider: graphhopper
  graphhopper_url: http://localhost:8989
`,
		);
		const config = await loadConfig(configFile);
		expect(config.routing?.provider).toBe("graphhopper");
		expect(config.routing?.fallback).toBe("osrm");
	});

	it("rejects malformed numeric rule parameters instead of using a default", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-config-"));
		directories.push(directory);
		const configFile = path.join(directory, "gpxlint.yml");
		await writeFile(
			configFile,
			`routing:
  batch_size: 99
`,
		);
		await expect(loadConfig(configFile)).rejects.toThrow(/Number must be/i);
	});
});
