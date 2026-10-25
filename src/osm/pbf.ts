/**
 * OSM PBF file parser for offline road matching.
 *
 * Reads a GeoFabrik-style OSM PBF extract, extracts all highway ways,
 * and returns them as OsmWay[] within a bounding box.
 *
 * Uses the `pbf` library (Mapbox) for protobuf wire format parsing.
 */

import { PbfReader } from "pbf";
import { readFileSync } from "node:fs";
import type { OsmBbox, OsmData, OsmWay } from "./cache";

// ── OSM PBF schema decoders (osmFileFormat.proto) ───────────

function readHeaderBlock(pbf: PbfReader): {
	blockrange: Array<{ fromidx: number; toidx: number; datasize: number }>;
} {
	const blockrange: Array<{
		fromidx: number;
		toidx: number;
		datasize: number;
	}> = [];
	let field;
	while ((field = pbf.nextField()) !== 0) {
		if (field === 2) {
			const end = pbf.readVarint() + pbf.pos;
			while (pbf.pos < end) {
				blockrange.push(readBlockRange(pbf, pbf.readVarint() + pbf.pos));
			}
		}
	}
	return { blockrange };
}

function readBlockRange(
	pbf: PbfReader,
	end: number,
): { fromidx: number; toidx: number; datasize: number } {
	let fromidx = 0,
		toidx = 0,
		datasize = 0;
	let field;
	while ((field = pbf.nextField(end)) !== 0) {
		if (field === 1) fromidx = pbf.readVarint();
		else if (field === 2) toidx = pbf.readVarint();
		else if (field === 3) datasize = pbf.readVarint();
	}
	return { fromidx, toidx, datasize };
}

function readPrimitiveBlock(pbf: PbfReader): {
	primitivegroup: Array<{
		nodes?: Array<{ id: number; lat: number; lon: number }>;
		dense?: { id: number[]; lat: number[]; lon: number[] };
		ways?: Array<{ id: number; nodes: number[]; tags: number[] }>;
	}>;
	stringtable?: { s: string[] };
} {
	const primitivegroup: Array<{
		nodes?: Array<{ id: number; lat: number; lon: number }>;
		dense?: { id: number[]; lat: number[]; lon: number[] };
		ways?: Array<{ id: number; nodes: number[]; tags: number[] }>;
	}> = [];
	let field;
	while ((field = pbf.nextField()) !== 0) {
		if (field === 1) {
			const end = pbf.readVarint() + pbf.pos;
			while (pbf.pos < end) {
				primitivegroup.push(
					readPrimitiveGroup(pbf, pbf.readVarint() + pbf.pos),
				);
			}
		} else if (field === 2) {
			const end = pbf.readVarint() + pbf.pos;
			const s: string[] = [];
			while (pbf.pos < end) {
				s.push(pbf.readString());
			}
			return { primitivegroup, stringtable: { s } };
		}
	}
	return { primitivegroup, stringtable: undefined };
}

function readPrimitiveGroup(
	pbf: PbfReader,
	end: number,
): {
	nodes?: Array<{ id: number; lat: number; lon: number }>;
	dense?: { id: number[]; lat: number[]; lon: number[] };
	ways?: Array<{ id: number; nodes: number[]; tags: number[] }>;
} {
	const group: {
		nodes?: Array<{ id: number; lat: number; lon: number }>;
		dense?: { id: number[]; lat: number[]; lon: number[] };
		ways?: Array<{ id: number; nodes: number[]; tags: number[] }>;
	} = {};
	let field;
	while ((field = pbf.nextField(end)) !== 0) {
		if (field === 1) {
			// Explicit nodes (field 1 of PrimitiveGroup)
			const nodes: Array<{ id: number; lat: number; lon: number }> = [];
			const nodeEnd = pbf.readVarint() + pbf.pos;
			while (pbf.pos < nodeEnd) {
				const nodeField = pbf.nextField();
				if (nodeField === 1) {
					pbf.skip(pbf.readVarint()); // int64 ID — skip (dense format assigns IDs)
				} else if (nodeField === 2) {
					nodes.push({ id: 0, lat: pbf.readFixed32(), lon: 0 });
				} else if (nodeField === 3) {
					if (nodes.length > 0) {
						nodes[nodes.length - 1].lon = pbf.readFixed32();
					}
				} else {
					pbf.skip(pbf.readVarint());
				}
			}
			group.nodes = nodes;
		} else if (field === 2) {
			// DenseInfo (field 2 of PrimitiveGroup)
			const dense: { id: number[]; lat: number[]; lon: number[] } = {
				id: [],
				lat: [],
				lon: [],
			};
			const denseEnd = pbf.readVarint() + pbf.pos;
			while (pbf.pos < denseEnd) {
				const denseField = pbf.nextField();
				if (denseField === 1) {
					dense.id.push(pbf.readVarint());
				} else if (denseField === 2) {
					pbf.readPackedVarint(dense.lat);
				} else if (denseField === 3) {
					pbf.readPackedVarint(dense.lon);
				} else {
					pbf.skip(pbf.readVarint());
				}
			}
			group.dense = dense;
		} else if (field === 3) {
			// Ways (field 3 of PrimitiveGroup)
			const ways: Array<{
				id: number;
				nodes: number[];
				tags: number[];
			}> = [];
			const wayEnd = pbf.readVarint() + pbf.pos;
			while (pbf.pos < wayEnd) {
				const wayField = pbf.nextField();
				if (wayField === 1) {
					ways.push({ id: pbf.readVarint(), nodes: [], tags: [] });
				} else if (wayField === 2) {
					const nodes: number[] = [];
					pbf.readPackedVarint(nodes);
					if (ways.length > 0) ways[ways.length - 1].nodes = nodes;
				} else if (wayField === 3) {
					const tags: number[] = [];
					pbf.readPackedVarint(tags);
					if (ways.length > 0) ways[ways.length - 1].tags = tags;
				} else {
					pbf.skip(pbf.readVarint());
				}
			}
			group.ways = ways;
		} else {
			pbf.skip(pbf.readVarint());
		}
	}
	return group;
}

// ── Tag & geometry helpers ───────────────────────────────────

/** Decode a flat tag index array into key-value pairs using the string table. */
function decodeTags(
	tags: number[],
	stringTable: string[],
): Record<string, string> {
	const result: Record<string, string> = {};
	for (let i = 0; i < tags.length; i += 2) {
		const keyIdx = tags[i];
		if (keyIdx < 0) continue;
		const valIdx = tags[i + 1];
		if (valIdx < 0) continue;
		const key = stringTable[keyIdx] ?? "";
		const val = stringTable[valIdx] ?? "";
		if (key) result[key] = val;
	}
	return result;
}

function wayIntersectsBbox(way: OsmWay, bbox: OsmBbox): boolean {
	for (const point of way.geometry) {
		if (
			point.lat >= bbox.latMin &&
			point.lat <= bbox.latMax &&
			point.lon >= bbox.lonMin &&
			point.lon <= bbox.lonMax
		) {
			return true;
		}
	}
	return false;
}

// ── Core: parsePbfBuffer (shared parsing logic) ────────────

/**
 * Parse a PBF buffer and extract highway ways with geometry.
 * Returns raw ways (not bbox-filtered).
 */
function parsePbfBuffer(buffer: Buffer): { ways: OsmWay[] } {
	const waysById = new Map<number, OsmWay>();
	const nodeMap = new Map<number, { lat: number; lon: number }>();

	// Parse header block to find block ranges
	const header = readHeaderBlock(new PbfReader(buffer));

	// Parse each binary block
	for (const block of header.blockrange) {
		const blockReader = new PbfReader(
			buffer.subarray(block.fromidx, block.toidx),
		);
		const primBlock = readPrimitiveBlock(blockReader);

		// Get the string table (if present)
		const stringTable: string[] = primBlock.stringtable
			? primBlock.stringtable.s
			: [];

		// Process each primitive group
		for (const group of primBlock.primitivegroup) {
			// Handle dense nodes (modern format)
			if (group.dense) {
				const { id, lat, lon } = group.dense;
				let currentLat = 0;
				let currentLon = 0;

				for (let i = 0; i < id.length; i++) {
					currentLat += lat[i];
					currentLon += lon[i];

					const nodeLat = currentLat * 1e-7;
					const nodeLon = currentLon * 1e-7;
					nodeMap.set(id[i], { lat: nodeLat, lon: nodeLon });
				}
			}

			// Handle explicit nodes (legacy format)
			if (group.nodes) {
				for (const node of group.nodes) {
					nodeMap.set(node.id, { lat: node.lat, lon: node.lon });
				}
			}

			// Process ways
			if (group.ways) {
				for (const way of group.ways) {
					const tags = decodeTags(way.tags, stringTable);

					// Only keep ways with highway tag
					if (!tags.highway) continue;

					// Build geometry from node references
					const geometry: { lat: number; lon: number }[] = [];
					for (const nodeRef of way.nodes) {
						const node = nodeMap.get(nodeRef);
						if (node) {
							geometry.push(node);
						}
					}

					// Skip ways with fewer than 2 points
					if (geometry.length < 2) continue;

					waysById.set(way.id, { id: way.id, tags, geometry });
				}
			}
		}
	}

	return { ways: Array.from(waysById.values()) };
}

// ── Core: parse PBF and extract highway ways ───────────────

/**
 * Parse an OSM PBF file and extract highway ways within a bbox.
 *
 * Returns OsmData compatible with fetchOverpassBboxWays().
 *
 * @param pbfPath — Path to a GeoFabrik-style OSM PBF extract.
 * @param bbox — Bounding box to filter ways.
 */
export function fetchPbfWays(pbfPath: string, bbox: OsmBbox): OsmData {
	const buffer = readFileSync(pbfPath);

	// Parse and filter by bbox; invalid PBF returns empty ways
	let parsed: { ways: OsmWay[] };
	try {
		parsed = parsePbfBuffer(buffer);
	} catch {
		return {
			ways: [],
			completedChunks: 1,
			totalChunks: 1,
			errors: [],
			cache: { hits: 0, misses: 0 },
			source: `pbf:${pbfPath}`,
		};
	}

	// Filter by bbox
	const ways: OsmWay[] = [];
	for (const way of parsed.ways) {
		if (wayIntersectsBbox(way, bbox)) {
			ways.push(way);
		}
	}

	return {
		ways,
		completedChunks: 1,
		totalChunks: 1,
		errors: [],
		cache: { hits: 0, misses: 0 },
		source: `pbf:${pbfPath}`,
	};
}
