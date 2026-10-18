---
title: "P2-11: Library hygiene"
priority: P2
category: "hygiene"
status: open
created: 2026-10-17
files:
  - src/linter.ts
  - src/resolver/cache.ts
  - src/osm/fetch.ts
  - src/constants.ts
  - src/types.ts
---

# P2-11: Library hygiene

## Problem

- `runLinter` writes four `[overpass]`-prefixed `console.error` lines unconditionally (`src/linter.ts`) — prints in *offline* mode too, and pollutes stderr for library consumers. Route progress through an injectable logger (you already have `deps`) and make the prefix dynamic.
- Cache writes use non-atomic `writeFile` — a mid-write crash corrupts the whole cache (next run discards everything). Write to tmp + rename.
- Road cache TTL is 30 days, OSM cache 7 days — align them so a cached match can't outlive the OSM data it was derived from.

## Fix

1. Add `logger?: { error(msg: string): void; warn?(msg: string): void }` to `deps` and route all `[overpass]` stderr through it. Skip logging in offline mode or make prefix dynamic based on provider.
2. Atomic cache writes: write to `${cachePath}.tmp` then `renameSync` (or `rename` async) to the target path.
3. Align cache TTLs: both should use the shorter TTL (7 days) or derive OSM cache TTL from the road cache TTL.

## Files

- `src/linter.ts` (console.error calls)
- `src/resolver/cache.ts` (writeCache)
- `src/osm/fetch.ts` (OSM cache write)
- `src/constants.ts` (TTL definitions)
- `src/types.ts` (deps interface)
