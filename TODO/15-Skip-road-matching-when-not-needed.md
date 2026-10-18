---
title: "P1-15: Road matching runs even when no enabled rule needs it"
priority: P1
category: "performance"
status: open
created: 2026-10-18
files:
  - src/linter.ts
  - src/engine.ts
  - src/resolver/index.ts
---

# P1-15: Road matching runs even when no enabled rule needs it

## Problem

`src/linter.ts` resolves road matches before checking what the active rules actually require. The code computes `needsOsmWays` from only one rule, but otherwise it triggers the full match pipeline regardless of whether the route uses road-sensitive checks at all.

This means purely geometric checks still incur expensive Overpass and snapping work, which is especially wasteful for long GPX files or non-road-focused validations.

## Why it matters

- Network-bound work can dominate runtime unnecessarily.
- Cache and provider load increase even when geometry-only rules are the only active checks.
- The performance profile worsens for large files and repeated validation runs.

## Fix

1. Build an `enabledRuleSummary` once at the start of the lint pipeline.
2. Skip `resolveRoads()` entirely when no enabled rule requires snapped road data.
3. Restrict OSM way fetches to rules that actually require geometry-level tag analysis.
4. Keep road data as optional dependency rather than unconditional prerequisite.

## Files

- `src/linter.ts`
- `src/engine.ts`
- `src/resolver/index.ts`
