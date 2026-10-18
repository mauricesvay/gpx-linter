---
title: "P2-07: Snapping re-does per-way work per point"
priority: P2
category: "performance"
status: done
created: 2026-10-17
files:
  - src/osm/snapping.ts
  - src/resolver/overpass.ts
---

# P2-07: Snapping re-does per-way work per point

## Problem

In `snapPointsToWays` (`src/osm/snapping.ts`), each (point, candidate-way) pair runs:

1. nearest-distance segment scan (per-segment `atan2` + `√`),
2. `computeBearingConsistency` (full segment loop),
3. `resolveDirection` (a *second* full segment loop, recomputing distances + bearings).

The same way is a candidate for thousands of points, so its segment bearings/lengths are recomputed thousands of times. **Fix:** precompute per-segment bearings/lengths/cumulative distance once when building the way index (`buildWayIndex`) and reuse. This is the biggest CPU cost on a 50k-point route.

## Files

- `src/osm/snapping.ts` (`snapPointsToWays`, `buildWayIndex`)
- `src/resolver/overpass.ts` (`snapPointsToWays` there too)
