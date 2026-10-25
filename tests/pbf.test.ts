/**
 * Tests for OSM PBF parsing — offline road matching.
 *
 * Tests the integration points (error handling, CLI options, resolver
 * flow) and the core parsing logic using a minimal valid PBF file.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchPbfWays } from "../src/osm/pbf";
import { resolveRoads } from "../src/resolver/index";
import { point } from "./fixtures";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

// ── Error handling ──────────────────────────────────────────────────

describe("fetchPbfWays error handling", () => {
	it("throws when the PBF file does not exist", () => {
		expect(() =>
			fetchPbfWays("/nonexistent/path/to/file.osm.pbf", {
				latMin: 0,
				lonMin: 0,
				latMax: 1,
				lonMax: 1,
			}),
		).toThrow();
	});

	it("returns an error when the PBF file is not a valid OSM PBF", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "invalid.osm.pbf");
		await writeFile(pbfPath, Buffer.from("not a pbf file"));

		const result = await fetchPbfWays(pbfPath, {
			latMin: 0,
			lonMin: 0,
			latMax: 1,
			lonMax: 1,
		});

		// Invalid PBF should return empty ways (no valid data parsed).
		expect(result.ways).toHaveLength(0);
		expect(result.source).toBe(`pbf:${pbfPath}`);
	});

	it("returns empty ways when the PBF has no highway ways", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "empty.osm.pbf");
		// Write a minimal valid PBF structure with no ways.
		await writeFile(
			pbfPath,
			Buffer.from([
				0x12, 0x09, 0x0a, 0x01, 0x02, 0x12, 0x01, 0x02, 0x1a, 0x01, 0x02, 0x0a,
				0x01, 0x00,
			]),
		);

		const result = await fetchPbfWays(pbfPath, {
			latMin: 0,
			lonMin: 0,
			latMax: 1,
			lonMax: 1,
		});

		expect(result.ways).toHaveLength(0);
	});
});

// ── Integration tests: offline resolver ─────────────────────────────

describe("offline PBF integration", () => {
	it("reports unavailable when offline mode has no PBF file", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-int-"));
		directories.push(directory);

		const result = await resolveRoads([point(48, 2.002)], {
			provider: "offline" as const,
			cache: false,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.matches[0].status).toBe("unmatched");
		expect(result.providerErrors[0]).toMatch(/No PBF file/);
	});

	it("reports errors when PBF file is unreadable", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-int-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "missing.osm.pbf");

		const result = await resolveRoads([point(48, 2.002)], {
			provider: "offline" as const,
			pbfPath,
			cache: false,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.matches[0].status).toBe("unmatched");
		expect(result.providerErrors[0]).toMatch(/PBF/);
	});

	it("returns partial availability when PBF has no matching roads", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-int-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "nomatch.osm.pbf");
		// Write a minimal valid PBF structure with no ways.
		await writeFile(
			pbfPath,
			Buffer.from([
				0x12, 0x09, 0x0a, 0x01, 0x02, 0x12, 0x01, 0x02, 0x1a, 0x01, 0x02, 0x0a,
				0x01, 0x00,
			]),
		);

		const result = await resolveRoads([point(48, 2.002)], {
			provider: "offline" as const,
			pbfPath,
			cache: false,
		});

		expect(result.availability.status).toBe("unavailable");
		expect(result.matches[0].status).toBe("unmatched");
	});
});

// ── CLI integration ─────────────────────────────────────────────────

describe("CLI --pbf option", () => {
	it("passes pbfPath through to the linter", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-cli-pbf-"));
		directories.push(directory);
		const gpxFile = path.join(directory, "route.gpx");
		const configFile = path.join(directory, "gpxlint.yml");
		const outputFile = path.join(directory, "report.json");
		const pbfPath = path.join(directory, "region.osm.pbf");

		await writeFile(
			gpxFile,
			`<gpx><trk><trkseg>
      <trkpt lat="48" lon="2"><ele>0</ele></trkpt>
      <trkpt lat="48" lon="2.001"><ele>0</ele></trkpt>
    </trkseg></trk></gpx>`,
		);
		await writeFile(
			configFile,
			`routing:
  provider: offline
rules:
  max_slope: { enabled: true }
  contraflow_bike: { enabled: false }
  roadworks: { enabled: false }
  sharp_turn: { enabled: false }
  off_road: { enabled: false }
  missing_elevation: { enabled: false }
  route_gaps: { enabled: false }
  loop_closure: { enabled: false }
`,
		);
		// Write a minimal valid PBF structure with no ways.
		await writeFile(
			pbfPath,
			Buffer.from([
				0x12, 0x09, 0x0a, 0x01, 0x02, 0x12, 0x01, 0x02, 0x1a, 0x01, 0x02, 0x0a,
				0x01, 0x00,
			]),
		);

		const { runCheck } = await import("../src/cli");
		const exitCode = await runCheck([gpxFile], {
			config: configFile,
			format: "json",
			output: outputFile,
			routing: "offline",
			pbf: pbfPath,
			cache: false,
		});

		const report = JSON.parse(await readFile(outputFile, "utf8"));

		// With no matching roads, availability should be unavailable.
		expect(exitCode).toBe(2);
		expect(report.availability.roadMatching.status).toBe("unavailable");
	});
});
