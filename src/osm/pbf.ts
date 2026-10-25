/**
 * OSM PBF file parser for offline road matching.
 *
 * Reads a GeoFabrik-style OSM PBF extract and returns highway ways within a
 * bounding box.
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PbfReader } from "pbf";
import type { OsmBbox, OsmData, OsmWay } from "./cache";

const MAX_BLOB_HEADER_SIZE = 64 * 1024;
const DEFAULT_GRANULARITY = 100;

interface RawWay {
	id: number;
	keys: number[];
	values: number[];
	refs: number[];
}

interface PrimitiveGroup {
	nodes: Array<{ id: number; lat: number; lon: number }>;
	dense?: { id: number[]; lat: number[]; lon: number[] };
	ways: RawWay[];
}

interface PrimitiveBlock {
	groups: PrimitiveGroup[];
	stringTable: string[];
	granularity: number;
	latOffset: number;
	lonOffset: number;
}

function skipField(pbf: PbfReader): void {
	pbf.skip(pbf.type);
}

function readBlobHeader(data: Uint8Array): { type: string; dataSize: number } {
	const pbf = new PbfReader(data);
	let type = "";
	let dataSize = 0;
	while (true) {
		const field = pbf.nextField();
		if (field === 0) break;
		if (field === 1) type = pbf.readString();
		else if (field === 3) dataSize = pbf.readVarint();
		else skipField(pbf);
	}
	if (!type || dataSize <= 0) {
		throw new Error("Invalid PBF blob header.");
	}
	return { type, dataSize };
}

function readBlob(data: Uint8Array): Uint8Array {
	const pbf = new PbfReader(data);
	let raw: Uint8Array | undefined;
	let compressed: Uint8Array | undefined;
	let rawSize: number | undefined;
	while (true) {
		const field = pbf.nextField();
		if (field === 0) break;
		if (field === 1) raw = pbf.readBytes();
		else if (field === 2) rawSize = pbf.readVarint();
		else if (field === 3) compressed = pbf.readBytes();
		else skipField(pbf);
	}

	if (raw) return raw;
	if (!compressed || rawSize === undefined) {
		throw new Error("PBF blob has no supported raw or zlib payload.");
	}
	const inflated = inflateSync(compressed);
	if (inflated.length !== rawSize) {
		throw new Error(
			`PBF blob size mismatch: expected ${rawSize} bytes, got ${inflated.length}.`,
		);
	}
	return inflated;
}

function readStringTable(pbf: PbfReader): string[] {
	const strings: string[] = [];
	const end = pbf.readVarint() + pbf.pos;
	while (true) {
		const field = pbf.nextField(end);
		if (field === 0) break;
		if (field === 1) strings.push(pbf.readString());
		else skipField(pbf);
	}
	return strings;
}

function readNode(
	pbf: PbfReader,
	end: number,
): {
	id: number;
	lat: number;
	lon: number;
} {
	let id = 0;
	let lat = 0;
	let lon = 0;
	while (true) {
		const field = pbf.nextField(end);
		if (field === 0) break;
		if (field === 1) id = pbf.readSVarint();
		else if (field === 8) lat = pbf.readSVarint();
		else if (field === 9) lon = pbf.readSVarint();
		else skipField(pbf);
	}
	return { id, lat, lon };
}

function readDenseNodes(pbf: PbfReader): {
	id: number[];
	lat: number[];
	lon: number[];
} {
	const dense = {
		id: [] as number[],
		lat: [] as number[],
		lon: [] as number[],
	};
	const end = pbf.readVarint() + pbf.pos;
	while (true) {
		const field = pbf.nextField(end);
		if (field === 0) break;
		if (field === 1) pbf.readPackedSVarint(dense.id);
		else if (field === 8) pbf.readPackedSVarint(dense.lat);
		else if (field === 9) pbf.readPackedSVarint(dense.lon);
		else skipField(pbf);
	}
	if (
		dense.id.length !== dense.lat.length ||
		dense.id.length !== dense.lon.length
	) {
		throw new Error("Malformed dense nodes: ID and coordinate counts differ.");
	}
	return dense;
}

function readWay(pbf: PbfReader, end: number): RawWay {
	const way: RawWay = { id: 0, keys: [], values: [], refs: [] };
	while (true) {
		const field = pbf.nextField(end);
		if (field === 0) break;
		if (field === 1) way.id = pbf.readVarint(true);
		else if (field === 2) pbf.readPackedVarint(way.keys);
		else if (field === 3) pbf.readPackedVarint(way.values);
		else if (field === 8) pbf.readPackedSVarint(way.refs);
		else skipField(pbf);
	}
	for (let i = 0; i < way.refs.length; i++) {
		way.refs[i] += i === 0 ? 0 : way.refs[i - 1];
	}
	return way;
}

function readPrimitiveGroup(pbf: PbfReader, end: number): PrimitiveGroup {
	const group: PrimitiveGroup = { nodes: [], ways: [] };
	while (true) {
		const field = pbf.nextField(end);
		if (field === 0) break;
		if (field === 1) {
			const nodeEnd = pbf.readVarint() + pbf.pos;
			group.nodes.push(readNode(pbf, nodeEnd));
		} else if (field === 2) {
			group.dense = readDenseNodes(pbf);
		} else if (field === 3) {
			const wayEnd = pbf.readVarint() + pbf.pos;
			group.ways.push(readWay(pbf, wayEnd));
		} else {
			skipField(pbf);
		}
	}
	return group;
}

function readPrimitiveBlock(data: Uint8Array): PrimitiveBlock {
	const pbf = new PbfReader(data);
	const block: PrimitiveBlock = {
		groups: [],
		stringTable: [],
		granularity: DEFAULT_GRANULARITY,
		latOffset: 0,
		lonOffset: 0,
	};
	while (true) {
		const field = pbf.nextField();
		if (field === 0) break;
		if (field === 1) {
			block.stringTable = readStringTable(pbf);
		} else if (field === 2) {
			const groupEnd = pbf.readVarint() + pbf.pos;
			block.groups.push(readPrimitiveGroup(pbf, groupEnd));
		} else if (field === 17) {
			block.granularity = pbf.readVarint();
		} else if (field === 19) {
			block.latOffset = pbf.readVarint(true);
		} else if (field === 20) {
			block.lonOffset = pbf.readVarint(true);
		} else {
			skipField(pbf);
		}
	}
	return block;
}

function decodeTags(
	keys: number[],
	values: number[],
	stringTable: string[],
): Record<string, string> {
	if (keys.length !== values.length) {
		throw new Error("Malformed OSM way: tag key and value counts differ.");
	}
	const tags: Record<string, string> = {};
	for (let i = 0; i < keys.length; i++) {
		const key = stringTable[keys[i]];
		const value = stringTable[values[i]];
		if (key !== undefined && value !== undefined) tags[key] = value;
	}
	return tags;
}

function coordinate(
	value: number,
	offset: number,
	granularity: number,
): number {
	return (offset + granularity * value) / 1e9;
}

function forEachPrimitiveBlock(
	buffer: Buffer,
	callback: (block: PrimitiveBlock) => void,
): void {
	let offset = 0;
	let sawHeader = false;

	while (offset < buffer.length) {
		if (buffer.length - offset < 4) {
			throw new Error("Truncated PBF file: missing blob header length.");
		}
		const headerSize = buffer.readUInt32BE(offset);
		offset += 4;
		if (headerSize === 0 || headerSize > MAX_BLOB_HEADER_SIZE) {
			throw new Error(`Invalid PBF blob header size: ${headerSize}.`);
		}
		if (offset + headerSize > buffer.length) {
			throw new Error("Truncated PBF file: incomplete blob header.");
		}

		const { type, dataSize } = readBlobHeader(
			buffer.subarray(offset, offset + headerSize),
		);
		offset += headerSize;
		if (offset + dataSize > buffer.length) {
			throw new Error(`Truncated PBF file: incomplete ${type} blob.`);
		}
		const blob = readBlob(buffer.subarray(offset, offset + dataSize));
		offset += dataSize;

		if (type === "OSMHeader") {
			sawHeader = true;
			continue;
		}
		if (type !== "OSMData") continue;
		if (!sawHeader)
			throw new Error("PBF data block appears before its header.");

		callback(readPrimitiveBlock(blob));
	}

	if (!sawHeader) throw new Error("Invalid OSM PBF: no OSMHeader block found.");
}

function parsePbfBuffer(buffer: Buffer): OsmWay[] {
	const rawWays: Array<{
		id: number;
		tags: Record<string, string>;
		refs: number[];
	}> = [];
	const referencedNodeIds = new Set<number>();

	forEachPrimitiveBlock(buffer, (block) => {
		for (const group of block.groups) {
			for (const way of group.ways) {
				const tags = decodeTags(way.keys, way.values, block.stringTable);
				if (tags.highway) {
					rawWays.push({ id: way.id, tags, refs: way.refs });
					for (const ref of way.refs) referencedNodeIds.add(ref);
				}
			}
		}
	});

	const nodeMap = new Map<number, { lat: number; lon: number }>();
	forEachPrimitiveBlock(buffer, (block) => {
		const addNode = (id: number, lat: number, lon: number) => {
			if (!referencedNodeIds.delete(id)) return;
			nodeMap.set(id, {
				lat: coordinate(lat, block.latOffset, block.granularity),
				lon: coordinate(lon, block.lonOffset, block.granularity),
			});
		};
		for (const group of block.groups) {
			for (const node of group.nodes) addNode(node.id, node.lat, node.lon);
			if (group.dense) {
				let id = 0;
				let lat = 0;
				let lon = 0;
				for (let i = 0; i < group.dense.id.length; i++) {
					id += group.dense.id[i];
					lat += group.dense.lat[i];
					lon += group.dense.lon[i];
					addNode(id, lat, lon);
				}
			}
		}
	});

	const ways: OsmWay[] = [];
	for (const way of rawWays) {
		const geometry: OsmWay["geometry"] = [];
		for (const ref of way.refs) {
			const node = nodeMap.get(ref);
			if (node) geometry.push(node);
		}
		if (geometry.length >= 2) {
			ways.push({ id: way.id, tags: way.tags, geometry });
		}
	}
	return ways;
}

function wayIntersectsBbox(way: OsmWay, bbox: OsmBbox): boolean {
	return way.geometry.some(
		(point) =>
			point.lat >= bbox.latMin &&
			point.lat <= bbox.latMax &&
			point.lon >= bbox.lonMin &&
			point.lon <= bbox.lonMax,
	);
}

/**
 * Parse an OSM PBF file and extract highway ways within a bounding box.
 *
 * @param pbfPath Path to a GeoFabrik-style OSM PBF extract.
 * @param bbox Bounding box to filter ways.
 */
export function fetchPbfWays(pbfPath: string, bbox: OsmBbox): OsmData {
	const buffer = readFileSync(pbfPath);
	const ways = parsePbfBuffer(buffer).filter((way) =>
		wayIntersectsBbox(way, bbox),
	);
	return {
		ways,
		completedChunks: 1,
		totalChunks: 1,
		errors: [],
		cache: { hits: 0, misses: 0 },
		source: `pbf:${pbfPath}`,
	};
}
