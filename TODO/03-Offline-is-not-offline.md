---
title: "P1-03: offline is not offline"
priority: P1
category: "contract"
status: done
resolved: 2026-01-25
resolved_commit: 4e71649
created: 2026-10-17
files:
  - src/linter.ts
  - README.md
  - src/osm/pbf.ts
  - src/osm/fetch.ts
  - src/resolver/index.ts
  - src/cli.ts
---

# P1-03: "offline" is not offline

## Problem (resolved)

In offline mode the linter still calls `enrichWithOsm`, which does a full Overpass bbox fetch (unless the 7-day OSM cache is warm) and *re-snaps every point*, then:

```ts
const routeMatches = osm?.matches ?? matching?.matches;
```

— the 30-day per-point cache results are silently discarded and replaced by the re-snap. So "offline" = "recompute from freshly-fetched OSM data", and the README's "no routing provider needed" is misleading.

## Fix (done)

Implemented PBF-based offline routing: `--routing offline --pbf <file>` parses
an OSM PBF extract from disk, extracts highway ways within the route's
bounding box, and snaps trackpoints locally. Zero network calls.

The resolver's offline path now calls `fetchOverpassBboxWays()` with a
`pbfPath` option, which delegates to `fetchPbfWays()` — a custom PBF wire
format parser that reads nodes and ways from the file directly.

## Files

- `src/osm/pbf.ts` — custom PBF parser (546 lines)
- `src/osm/fetch.ts` — PBF early-return in `fetchOverpassBboxWays()`
- `src/resolver/index.ts` — offline path wired to PBF
- `src/cli.ts` — `--pbf <file>` CLI option
- `src/linter.ts` — passes `pbfPath` through pipeline
- `src/types.ts` — `pbf_path` in routing config
- `src/configSchema.ts` — Zod schema for `pbf_path`
- `README.md` — documented PBF offline mode
