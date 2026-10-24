---
finding_id: 18
category: nice_to_have
severity: info
component: src/resolver/cache.ts
status: open
tags:
  - lean
  - dead_code
---

# Remove unused `makeCacheEntry`

## What this is

`makeCacheEntry` creates a `CacheEntry` from a point and result. It is never called anywhere in the codebase.

## Problem

Dead function.

## Fix

Remove `makeCacheEntry`.

## Lean

-5 lines.
