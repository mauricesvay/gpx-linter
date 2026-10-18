---
title: "P1-06: needsOsmWays couples to one rule"
priority: P1
category: "contract"
status: open
created: 2026-10-17
files:
  - src/linter.ts
  - src/engine.ts
---

# P1-06: `needsOsmWays` couples OSM-way fetching to one rule

## Problem

`src/linter.ts`:

```ts
const needsOsmWays = enabled(config, "bike_lane_no_same_direction_car_lane");
```

but the fetched ways also feed `off_road`'s context and the reported `osmWaysAvailability` block. If a user disables bike_lane, `osmWays` is undefined for everything else.

## Fix

Declare `requiresOsmWays` in `RuleMetadata` and derive the fetch flag from any enabled rule that consumes `ctx.osmWays`.

```ts
const needsOsmWays = Object.values(registry)
  .filter(m => m.requiresOsmWays)
  .some(m => enabled(config, m.id));
```

## Files

- `src/linter.ts` (line ~137)
- `src/engine.ts` (`RuleMetadata` interface — add `requiresOsmWays: boolean`)
