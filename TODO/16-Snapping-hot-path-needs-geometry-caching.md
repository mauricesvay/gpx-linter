---
title: "P1-16: Snapping hot path recomputes per-way geometry work per point"
priority: P1
category: "performance"
status: open
created: 2026-10-18
files:
  - src/osm/snapping.ts
  - src/geo.ts
---

# P1-16: Snapping hot path recomputes per-way geometry work per point

## Problem

The road snapping implementation in `src/osm/snapping.ts` does repeated nearest-segment distance and bearing calculations for each candidate way and each point. This occurs in the hottest path of the project and becomes a serious cost for large GPX tracks or dense OSM datasets.

The current logic performs expensive geometry checks repeatedly instead of reusing segment metadata and coarse spatial filters.

## Why it matters

- Runtime scales poorly with GPX length and number of nearby candidate ways.
- Matching large routes can become the dominant cost of the tool.
- Performance regressions are hard to spot without targeted benchmarks.

## Fix

1. Precompute per-way segment metadata once: segment endpoints, lengths, and bearings.
2. Reuse segment index data across all point evaluations.
3. Keep the grid/bbox fast-path, but avoid doing full nearest-segment calculations until a candidate is already close enough.
4. Cache repeated distance or heading computations for identical geometry contexts.
5. Add a benchmark test around a representative long GPX route to prevent regressions.

## Files

- `src/osm/snapping.ts`
- `src/geo.ts`
