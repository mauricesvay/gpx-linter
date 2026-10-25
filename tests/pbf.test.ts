/**
 * Tests for OSM PBF parsing — offline road matching.
 *
 * Tests the integration points (error handling, CLI options, resolver
 * flow) and the core parsing logic using a minimal valid PBF file.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PbfWriter } from "pbf";
import { afterEach, describe, expect, it } from "vitest";
import { enrichWithOsm } from "../src/osm/enrichment";
import { fetchPbfWays } from "../src/osm/pbf";
import { resolveRoads } from "../src/resolver/index";
import { point } from "./fixtures";

const directories: string[] = [];

function encodeMessage(write: (pbf: PbfWriter) => void): Uint8Array {
	const pbf = new PbfWriter();
	write(pbf);
	return pbf.finish();
}

function frameBlock(type: string, data: Uint8Array): Buffer {
	const blob = encodeMessage((pbf) => {
		pbf.writeVarintField(2, data.length);
		pbf.writeBytesField(3, deflateSync(data));
	});
	const header = encodeMessage((pbf) => {
		pbf.writeStringField(1, type);
		pbf.writeVarintField(3, blob.length);
	});
	const frame = Buffer.alloc(4);
	frame.writeUInt32BE(header.length);
	return Buffer.concat([frame, header, blob]);
}

function createPbfFile(withHighway = false): Buffer {
	const header = encodeMessage((pbf) => {
		pbf.writeStringField(4, "OsmSchema-V0.6");
		pbf.writeStringField(5, "DenseNodes");
	});
	const data = encodeMessage((pbf) => {
		pbf.writeMessage(
			1,
			(_value, table) => {
				table.writeStringField(1, "");
				table.writeStringField(1, "highway");
				table.writeStringField(1, "residential");
			},
			{},
		);
		if (!withHighway) return;
		pbf.writeMessage(
			2,
			(_value, group) => {
				group.writeMessage(
					2,
					(_dense, nodes) => {
						nodes.writePackedSVarint(1, [100, 1]);
						nodes.writePackedSVarint(8, [480_000_000, 1_000]);
						nodes.writePackedSVarint(9, [20_000_000, 1_000]);
					},
					{},
				);
				group.writeMessage(
					3,
					(_way, way) => {
						way.writeVarintField(1, 10);
						way.writePackedVarint(2, [1]);
						way.writePackedVarint(3, [2]);
						way.writePackedSVarint(8, [100, 1]);
					},
					{},
				);
			},
			{},
		);
	});
	return Buffer.concat([
		frameBlock("OSMHeader", header),
		frameBlock("OSMData", data),
	]);
}

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

	it("throws a useful error when the PBF file is malformed", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "invalid.osm.pbf");
		await writeFile(pbfPath, Buffer.from("not a pbf file"));

		expect(() =>
			fetchPbfWays(pbfPath, {
				latMin: 0,
				lonMin: 0,
				latMax: 1,
				lonMax: 1,
			}),
		).toThrow(/Invalid PBF blob header size/);
	});

	it("returns empty ways when the PBF has no highway ways", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "empty.osm.pbf");
		await writeFile(pbfPath, createPbfFile());

		const result = await fetchPbfWays(pbfPath, {
			latMin: 0,
			lonMin: 0,
			latMax: 1,
			lonMax: 1,
		});

		expect(result.ways).toHaveLength(0);
	});

	it("decodes compressed dense nodes and way references", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "road.osm.pbf");
		await writeFile(pbfPath, createPbfFile(true));

		const result = fetchPbfWays(pbfPath, {
			latMin: 47.9,
			lonMin: 1.9,
			latMax: 48.1,
			lonMax: 2.1,
		});

		expect(result.ways).toEqual([
			{
				id: 10,
				tags: { highway: "residential" },
				geometry: [
					{ lat: 48, lon: 2 },
					{ lat: 48.0001, lon: 2.0001 },
				],
			},
		]);
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

	it("matches and enriches route points entirely from the PBF", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-int-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "road.osm.pbf");
		const points = [point(48, 2, 0, 0), point(48.0001, 2.0001, 0, 1)];
		await writeFile(pbfPath, createPbfFile(true));

		const resolved = await resolveRoads(points, {
			provider: "offline",
			pbfPath,
			cache: false,
		});
		const enriched = await enrichWithOsm(points, resolved.matches, {
			pbfPath,
			cache: false,
			fetcher: async () => {
				throw new Error("Offline enrichment attempted a network request.");
			},
		});

		expect(resolved.matches.map((match) => match.status)).toEqual([
			"matched",
			"matched",
		]);
		expect(resolved.matches[0].roadId).toBe("10");
		expect(enriched.matches[0].tags).toEqual({
			highway: "residential",
		});
		expect(enriched.availability.status).toBe("complete");
		expect(enriched.providerErrors).toEqual([]);
	});

	it("returns partial availability when PBF has no matching roads", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "gpxlint-pbf-int-"));
		directories.push(directory);
		const pbfPath = path.join(directory, "nomatch.osm.pbf");
		await writeFile(pbfPath, createPbfFile());

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
      <trkpt lat="48.0001" lon="2.0001"><ele>0</ele></trkpt>
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
		await writeFile(pbfPath, createPbfFile(true));

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

		expect(exitCode).toBe(0);
		expect(report.availability.roadMatching.status).toBe("complete");
		expect(report.availability.osm.status).toBe("complete");
	});
});
