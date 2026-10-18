---
title: "P0-14: Road cache writes are non-atomic and never expire on disk"
priority: P0
category: "data-integrity"
status: open
created: 2026-10-18
files:
  - src/resolver/cache.ts
  - src/resolver/index.ts
  - src/osm/fetch.ts
---

# P0-14: Road cache writes are non-atomic and never expire on disk

## Problem

The road cache in `src/resolver/cache.ts` validates entry version and usability, but it does not enforce TTL expiry when reading or rewriting cached results. In `src/resolver/index.ts`, the entire cache object is written back to disk without locking or atomic replacement.

This creates multiple risks:

- stale entries remain indefinitely and are reused after they should expire,
- partial writes can leave a corrupt `cache.json` behind,
- large GPX files produce a growing cache file that is rewritten on every run.

The same pattern exists in the OSM chunk cache pipeline and compounds the same data-integrity issue.

## Why it matters

- Performance degrades as cache size grows without bound.
- Cross-run determinism drops if partial cache writes are read.
- Older matches can become increasingly misleading as route conditions change.

## Fix

1. Enforce TTL expiry during both read and write paths.
2. Delete stale keys before serializing the cache.
3. Write cache data to a temporary file and rename it atomically.
4. Add a cap or eviction strategy for oversized cache files if needed.
5. Consider normalizing cache keys to a quantized location to improve hit rates for repeated routes.

## Files

- `src/resolver/cache.ts`
- `src/resolver/index.ts`
- `src/osm/fetch.ts`
