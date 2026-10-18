---
title: "P2-09: npm run lint is red"
priority: P2
category: "hygiene"
status: open
created: 2026-10-17
files:
  - package.json
  - biome.json
---

# P2-09: `npm run lint` is red

## Problem

Biome reports 36 errors / 59 warnings across 34 files: unused imports (`osm/fetch`, `osm/cache`, `linter.ts`, `segment_analysis.ts`…), ~18 `noNonNullAssertion`, one unused variable, formatting drift. `check` runs only test+build, so lint is unenforced.

## Fix

1. `biome check --write` — auto-fix formatting and remove unused imports
2. Add `lint` to the `check` script in `package.json`
3. Prefer guards over `!` in the snapping code — several `topCandidate!` assertions stand on earlier checks that a guard would make explicit

## Files

- `package.json` (scripts)
- `biome.json` (verify `check` script includes lint)
- All 34 files with lint errors
