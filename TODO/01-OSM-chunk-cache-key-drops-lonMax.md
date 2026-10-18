---
title: "P0-01: OSM chunk cache key drops lonMax"
priority: P0
category: "data-integrity"
status: done
created: 2026-10-17
files:
  - src/osm/cache.ts
  - tests/geo.test.ts
---

# P0-01: OSM chunk cache key drops `lonMax` — wrong roads served

## Problem

`src/osm/cache.ts:160-168` — `bboxKeyString` computes:

```ts
return [
  (Math.floor(b.latMin / grid) * grid).toFixed(4),
  (Math.floor(b.lonMin / grid) * grid).toFixed(4),
  (Math.floor(b.latMax / grid) * grid).toFixed(4),
  (Math.floor(b.latMax / grid) * grid).toFixed(4),  // ← latMax twice, lonMax never
].join(",");
```

The fourth component is `latMax` again instead of `lonMax`. Two different route bboxes that share a grid-cell origin but differ in size (e.g. a loop vs a longer out-and-back starting in the same cell) produce identical keys. The second route silently reuses the first route's truncated way set for up to the 7-day TTL → points in the extra area snap to nothing.

## Fix

- (a) Use `b.lonMax` for the fourth component
- (b) Don't floor the max values — key on the exact boundary (`toFixed(5)`), **or** better: fetch full cells (drop the clamp) and key on the cell origin only

## Regression test

Add to `tests/geo.test.ts` (currently 2 tests, roadworks geometry only, zero coverage of `routeBbox`/`bboxKey`):

- Two bboxes sharing a grid-cell origin but different sizes must produce different cache keys
- Verify `bboxKeyString` includes all four coordinates

## Files

- `src/osm/cache.ts` (line ~160-168)
- `tests/geo.test.ts`
