---
finding_id: 10
category: should_fix
severity: low
component: src/resolver/index.ts
status: open
tags:
  - resolver
  - performance
  - memory
---

# Sparse Array Wastes Memory for Large Point Lists

## What this is

`matches` is initialized as a sparse array (`new Array(points.length)`). Cache hits fill entries; cache misses push to `misses`/`missIndexes` arrays. The sparse array is converted to a dense array at the end with `Array.from(matches, ...)`.

## Problem

The intermediate sparse array is wasteful for large files (50k elements).

## Fix

Use a regular array and index directly. No functional change, minor memory win.

## If we skip it

Negligible memory overhead for typical use. Acceptable.
