---
finding_id: 24
category: nice_to_have
severity: info
component: src/osm/cache.ts
status: open
tags:
  - lean
  - duplication
---

# `CLI_VERSION` re-exported from `osm/cache.ts` is unnecessary

## What this is

`osm/cache.ts` re-exports `CLI_VERSION` from `../constants`. This is only used by `fetch.ts` which imports from `../constants` directly.

## Problem

Circular re-export chain. `osm/cache.ts` re-exports constants that `fetch.ts` (which imports from `osm/cache.ts`) already imports from `../constants`.

## Fix

Remove the re-export from `osm/cache.ts`. Let `fetch.ts` import `CLI_VERSION` directly from `../constants`.

## Lean

-5 lines.
