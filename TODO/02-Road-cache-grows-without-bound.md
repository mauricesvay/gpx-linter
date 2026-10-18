---
title: "P0-02: Road cache grows without bound"
priority: P0
category: "data-integrity"
status: open
created: 2026-10-17
files:
  - src/resolver/cache.ts
  - src/osm/fetch.ts
---

# P0-02: Road cache grows without bound and never expires from disk

## Problem

`src/resolver/cache.ts` — `normalizeCacheEntry` checks version/usability but **not TTL**. Expired entries are loaded, and `writeCache` rewrites the entire record. Every point key ever seen stays in `cache.json` forever (~200 B/entry → a 50k-point route adds ~10 MB, and the file is fully parsed + rewritten on *every* run).

Same pattern in OSM cache (`src/osm/fetch.ts`): `Object.assign(entries, fetched)` then write-all; each 22×22 km cell is a permanent multi-MB geometry blob.

## Fix

1. Drop entries past TTL on write (or cap by count/bytes, LRU by last use)
2. `cacheKey` hashes the *exact* `lat,lon` string — two recordings of the same ride produce **zero** hits. Quantize the key (5 dp ≈ 1 m) so re-rides of a route actually cache

## Files

- `src/resolver/cache.ts`
- `src/osm/fetch.ts` (OSM cache write pattern)
