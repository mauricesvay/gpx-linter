---
title: "P1-03: offline is not offline"
priority: P1
category: "contract"
status: open
created: 2026-10-17
files:
  - src/linter.ts
  - README.md
---

# P1-03: "offline" is not offline

## Problem

In offline mode the linter still calls `enrichWithOsm`, which does a full Overpass bbox fetch (unless the 7-day OSM cache is warm) and *re-snaps every point*, then:

```ts
const routeMatches = osm?.matches ?? matching?.matches;
```

— the 30-day per-point cache results are silently discarded and replaced by the re-snap. So "offline" = "recompute from freshly-fetched OSM data", and the README's "no routing provider needed" is misleading.

## Fix

Rename/repurpose — e.g. `replay` (true offline, uses the per-point cache) vs `recompute` (current behavior) — and document. Or make it actually skip the network when the OSM cache is cold and fail with a clear "run overpass mode first" error.

## Files

- `src/linter.ts` (offline routing path)
- `README.md` (user-facing contract)
