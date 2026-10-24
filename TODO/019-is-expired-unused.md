---
finding_id: 19
category: nice_to_have
severity: info
component: src/resolver/cache.ts
status: open
tags:
  - lean
  - dead_code
---

# Remove unused `isExpired` export

## What this is

`isExpired(entry, ttlMs)` checks if a cache entry has expired. It is never called anywhere in the codebase.

## Problem

Dead export.

## Fix

Remove `isExpired`.

## Lean

-5 lines.
