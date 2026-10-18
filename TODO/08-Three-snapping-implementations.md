---
title: "P2-08: Three snapping implementations"
priority: P2
category: "performance"
status: done
created: 2026-10-17
resolved: 2026-10-18
files:
  - src/resolver/overpass.ts
  - src/osm/enrichment.ts
  - src/osm/snapping.ts
---

# P2-08: Three snapping implementations

## Problem

`snapPointsToWays` (`src/resolver/overpass.ts`), `snapSinglePoint` (`src/osm/enrichment.ts`), `findNearestWay` (`src/osm/snapping.ts`) duplicate the same multi-factor scoring with subtle differences — they can diverge silently (offline vs overpass modes already produce different matches for the same GPX).

## Fix

Extract one shared core (score + direction) parameterized by candidate set, used by all three.

## Files

- `src/resolver/overpass.ts` (`snapPointsToWays`)
- `src/osm/enrichment.ts` (`snapSinglePoint`)
- `src/osm/snapping.ts` (`findNearestWay`)

## Notes

Refactored to a single `snapSinglePoint` core in `src/osm/snapping.ts`, called by both `snapPointsToWays` (same file) and `enrichMatches` (`enrichment.ts`). Multi-factor scoring (distance 50%, bearing 30%, road class 20%, continuity bonus) and direction resolution are no longer duplicated.
