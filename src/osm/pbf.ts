/**
 * OSM PBF file parser for offline road matching.
 *
 * Reads a GeoFabrik-style OSM PBF extract, extracts all highway ways,
 * and returns them as OsmWay[] within a bounding box.
 */

import { readFileSync } from "node:fs";
import type { OsmBbox, OsmData, OsmWay } from "./cache";

// ── Low-level PBF wire format helpers ──────────────────────

function readVarint(
	buffer: Buffer,
	offset: number,
): {
	value: number;
	nextOffset: number;
} {
	let result = 0;
	let shift = 0;
	let pos = offset;
	while (pos < buffer.length) {
		const byte = buffer[pos++];
		result |= (byte & 0x7f) << shift;
		shift += 7;
		if ((byte & 0x80) === 0) break;
	}
	return { value: result, nextOffset: pos };
}

function readInt32(
	buffer: Buffer,
	offset: number,
): {
	value: number;
	nextOffset: number;
} {
	return { value: buffer.readUInt32LE(offset), nextOffset: offset + 4 };
}

// ── Tag decoding ───────────────────────────────────────────

/**
 * Decode a flat tag index array into key-value pairs using the string table.
 */
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

// ── BBox intersection check ────────────────────────────────

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
	const waysById = new Map<number, OsmWay>();
	const nodeMap = new Map<number, { lat: number; lon: number }>();

	const buffer = readFileSync(pbfPath);

	// Parse header block to find block ranges
	const header = parseHeaderBlock(buffer);

	// Parse each binary block
	for (const block of header.blockrange) {
		// Read binary block (field 1 = data, length-delimited)
		const blockReader = new BlockReader(buffer, block.fromidx);
		const dataBuffer = blockReader.readData();
		if (!dataBuffer) continue;

		// Parse the primitive block from the data buffer
		const primBlock = parsePrimitiveBlock(dataBuffer);

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

					// Filter by bbox
					if (wayIntersectsBbox({ id: way.id, tags, geometry }, bbox)) {
						waysById.set(way.id, { id: way.id, tags, geometry });
					}
				}
			}
		}
	}

	const ways = Array.from(waysById.values());
	return {
		ways,
		completedChunks: 1,
		totalChunks: 1,
		errors: [],
		cache: { hits: 0, misses: 0 },
		source: `pbf:${pbfPath}`,
	};
}

// ── PBF parsing helpers ────────────────────────────────────

interface HeaderBlock {
	blockrange: Array<{ fromidx: number; toidx: number; datasize: number }>;
}

interface PrimitiveBlock {
	primitivegroup: Array<{
		nodes?: Array<{ id: number; lat: number; lon: number }>;
		dense?: { id: number[]; lat: number[]; lon: number[] };
		ways?: Array<{ id: number; nodes: number[]; tags: number[] }>;
	}>;
	stringtable?: { s: string[] };
}

class BlockReader {
	constructor(
		private buffer: Buffer,
		private offset: number,
	) {}

	readData(): Buffer | null {
		const pos = this.offset;

		// Read field tag
		const { value: tag, nextOffset: afterTag } = readVarint(this.buffer, pos);
		const wireType = tag & 7;
		const fieldNumber = tag >>> 3;
		const fieldPos = afterTag;

		// Field 1 = data (length-delimited)
		if (fieldNumber !== 1 || wireType !== 2) return null;

		// Read length
		const { value: length, nextOffset: afterLength } = readVarint(
			this.buffer,
			fieldPos,
		);

		return this.buffer.subarray(afterLength, afterLength + length);
	}
}

function parseHeaderBlock(buffer: Buffer): HeaderBlock {
	const blockrange: Array<{
		fromidx: number;
		toidx: number;
		datasize: number;
	}> = [];
	let pos = 0;

	while (pos < buffer.length) {
		const { value: tag, nextOffset: afterTag } = readVarint(buffer, pos);
		const wireType = tag & 7;
		const fieldNumber = tag >>> 3;
		pos = afterTag;

		if (wireType === 2) {
			const { value: length, nextOffset: afterLength } = readVarint(
				buffer,
				pos,
			);
			const dataEnd = afterLength + length;

			if (fieldNumber === 2) {
				// Parse BlockRange (field 2 = blockrange)
				let blockPos = afterLength;
				let fromidx = 0,
					toidx = 0,
					datasize = 0;

				while (blockPos < dataEnd) {
					const { value: blockTag, nextOffset: blockAfterTag } = readVarint(
						buffer,
						blockPos,
					);
					const blockWireType = blockTag & 7;
					const blockFieldNumber = blockTag >>> 3;
					blockPos = blockAfterTag;

					if (blockWireType === 0) {
						const { value: blockValue, nextOffset: blockAfterValue } =
							readVarint(buffer, blockPos);
						blockPos = blockAfterValue;
						if (blockFieldNumber === 1) fromidx = blockValue;
						else if (blockFieldNumber === 2) toidx = blockValue;
						else if (blockFieldNumber === 3) datasize = blockValue;
					} else {
						// Skip length-delimited (shouldn't happen in BlockRange)
						const { value: blockLength, nextOffset: blockAfterLength } =
							readVarint(buffer, blockPos);
						blockPos = blockAfterLength + blockLength;
					}
				}

				blockrange.push({ fromidx, toidx, datasize });
			}

			pos = dataEnd;
		} else {
			pos = buffer.length;
		}
	}

	return { blockrange };
}

function parsePrimitiveBlock(buffer: Buffer): PrimitiveBlock {
	const primitivegroup: Array<{
		nodes?: Array<{ id: number; lat: number; lon: number }>;
		dense?: { id: number[]; lat: number[]; lon: number[] };
		ways?: Array<{ id: number; nodes: number[]; tags: number[] }>;
	}> = [];
	let stringtable: { s: string[] } | undefined;
	let pos = 0;

	while (pos < buffer.length) {
		const { value: tag, nextOffset: afterTag } = readVarint(buffer, pos);
		const wireType = tag & 7;
		const fieldNumber = tag >>> 3;
		pos = afterTag;

		if (wireType === 2) {
			const { value: length, nextOffset: afterLength } = readVarint(
				buffer,
				pos,
			);
			const dataEnd = afterLength + length;

			if (fieldNumber === 1) {
				// Parse PrimitiveGroup (field 1)
				const group: PrimitiveBlock["primitivegroup"][number] = {};
				let groupPos = afterLength;

				while (groupPos < dataEnd) {
					const { value: groupTag, nextOffset: groupAfterTag } = readVarint(
						buffer,
						groupPos,
					);
					const groupWireType = groupTag & 7;
					const groupFieldNumber = groupTag >>> 3;
					groupPos = groupAfterTag;

					if (groupWireType === 2) {
						const { value: groupLength, nextOffset: groupAfterLength } =
							readVarint(buffer, groupPos);
						const groupDataEnd = groupAfterLength + groupLength;

						if (groupFieldNumber === 1) {
							// Explicit nodes (field 1 of PrimitiveGroup)
							const nodes: Array<{ id: number; lat: number; lon: number }> = [];
							let nodePos = groupAfterLength;

							while (nodePos < groupDataEnd) {
								const { value: nodeTag, nextOffset: nodeAfterTag } = readVarint(
									buffer,
									nodePos,
								);
								const nodeWireType = nodeTag & 7;
								const nodeFieldNumber = nodeTag >>> 3;
								nodePos = nodeAfterTag;

								if (nodeWireType === 0) {
									const { nextOffset: nodeAfterValue } = readVarint(
										buffer,
										nodePos,
									);
									nodePos = nodeAfterValue;
									if (nodeFieldNumber === 1) {
										// Node ID (int64) — skip for dense format
									}
								} else if (nodeWireType === 2) {
									const { value: nodeLength, nextOffset: nodeAfterLength } =
										readVarint(buffer, nodePos);
									const nodeDataEnd = nodeAfterLength + nodeLength;

									if (nodeFieldNumber === 2) {
										// Node latitude (int32)
										const { value: nodeLat } = readInt32(
											buffer,
											nodeAfterLength,
										);
										nodes.push({ id: 0, lat: nodeLat, lon: 0 });
										nodePos = nodeDataEnd;
									} else if (nodeFieldNumber === 3) {
										// Node longitude (int32)
										const { value: nodeLon } = readInt32(buffer, nodePos);
										if (nodes.length > 0) {
											nodes[nodes.length - 1].lon = nodeLon;
										}
										nodePos = nodeDataEnd;
									} else {
										nodePos = nodeDataEnd;
									}
								} else {
									nodePos = groupDataEnd;
								}
							}

							// Assign IDs from the dense format (if any)
							// For explicit nodes, we skip — they're handled by dense format
							group.nodes = nodes;
							groupPos = groupDataEnd;
						} else if (groupFieldNumber === 2) {
							// DenseInfo (field 2 of PrimitiveGroup)
							const dense: {
								id: number[];
								lat: number[];
								lon: number[];
							} = { id: [], lat: [], lon: [] };
							let densePos = groupAfterLength;

							while (densePos < groupDataEnd) {
								const { value: denseTag, nextOffset: denseAfterTag } =
									readVarint(buffer, densePos);
								const denseWireType = denseTag & 7;
								const denseFieldNumber = denseTag >>> 3;
								densePos = denseAfterTag;

								if (denseWireType === 0) {
									const { value: denseValue, nextOffset: denseAfterValue } =
										readVarint(buffer, densePos);
									densePos = denseAfterValue;
									if (denseFieldNumber === 1) {
										dense.id.push(denseValue);
									}
								} else if (denseWireType === 2) {
									const { value: denseLength, nextOffset: denseAfterLength } =
										readVarint(buffer, densePos);
									const denseDataEnd = denseAfterLength + denseLength;

									if (denseFieldNumber === 2) {
										// Dense latitude (repeated int32)
										while (densePos < denseDataEnd) {
											const { value: denseValue } = readInt32(buffer, densePos);
											dense.lat.push(denseValue);
											densePos += 4;
										}
									} else if (denseFieldNumber === 3) {
										// Dense longitude (repeated int32)
										while (densePos < denseDataEnd) {
											const { value: denseValue } = readInt32(buffer, densePos);
											dense.lon.push(denseValue);
											densePos += 4;
										}
									} else {
										densePos = denseDataEnd;
									}
								} else {
									densePos = groupDataEnd;
								}
							}

							group.dense = dense;
							groupPos = groupDataEnd;
						} else if (groupFieldNumber === 3) {
							// Ways (field 3 of PrimitiveGroup)
							const ways: Array<{
								id: number;
								nodes: number[];
								tags: number[];
							}> = [];
							let wayPos = groupAfterLength;

							while (wayPos < groupDataEnd) {
								const { value: wayTag, nextOffset: wayAfterTag } = readVarint(
									buffer,
									wayPos,
								);
								const wayWireType = wayTag & 7;
								const wayFieldNumber = wayTag >>> 3;
								wayPos = wayAfterTag;

								if (wayWireType === 0) {
									const { nextOffset: wayAfterValue } = readVarint(
										buffer,
										wayPos,
									);
									wayPos = wayAfterValue;
									if (wayFieldNumber === 1) {
										// Way ID (int64)
									}
								} else if (wayWireType === 2) {
									const { value: wayLength, nextOffset: wayAfterLength } =
										readVarint(buffer, wayPos);
									const wayDataEnd = wayAfterLength + wayLength;

									if (wayFieldNumber === 2) {
										// Way nodes (repeated int32, varint-encoded)
										const nodes: number[] = [];
										while (wayPos < wayDataEnd) {
											const { value: wayValue, nextOffset: wayAfterValue } =
												readVarint(buffer, wayPos);
											nodes.push(wayValue);
											wayPos = wayAfterValue;
										}
										// Store as part of way object
									} else if (wayFieldNumber === 3) {
										// Way tags (repeated int32, varint-encoded)
										const tags: number[] = [];
										while (wayPos < wayDataEnd) {
											const { value: wayValue, nextOffset: wayAfterValue } =
												readVarint(buffer, wayPos);
											tags.push(wayValue);
											wayPos = wayAfterValue;
										}
										// Store as part of way object
									} else {
										wayPos = wayDataEnd;
									}
								} else {
									wayPos = groupDataEnd;
								}
							}

							group.ways = ways;
							groupPos = groupDataEnd;
						} else {
							// Skip unknown field type
							const { value: skipLength, nextOffset: skipAfter } = readVarint(
								buffer,
								groupPos,
							);
							groupPos = skipAfter + skipLength;
						}
					} else {
						// Skip unknown field type
						const { value: skipLength, nextOffset: skipAfter } = readVarint(
							buffer,
							groupPos,
						);
						groupPos = skipAfter + skipLength;
					}
				}

				primitivegroup.push(group);
				pos = dataEnd;
			} else if (fieldNumber === 2) {
				// String table (field 2 of PrimitiveBlock)
				const { value: strLength, nextOffset: strAfterLength } = readVarint(
					buffer,
					pos,
				);
				const strDataEnd = strAfterLength + strLength;

				const s: string[] = [];
				while (pos < strDataEnd) {
					const { value: strLen, nextOffset: strAfter } = readVarint(
						buffer,
						pos,
					);
					const strValue = buffer.toString("utf8", strAfter, strAfter + strLen);
					pos = strAfter + strLen;
					s.push(strValue);
				}

				stringtable = { s };
				pos = strDataEnd;
			} else {
				// Skip unknown field
				pos = dataEnd;
			}
		} else {
			// Skip non-length-delimited field
			pos = buffer.length;
		}
	}

	return { primitivegroup, stringtable };
}
