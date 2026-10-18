---
title: "P2-08: Three snapping implementations"
priority: P2
category: "performance"
status: open
created: 2026-10-17
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
