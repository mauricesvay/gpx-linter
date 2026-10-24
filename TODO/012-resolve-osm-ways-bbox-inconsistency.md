---
finding_id: 12
category: should_fix
severity: low
component: src/resolver/index.ts
status: open
tags:
  - resolver
  - overpass
  - consistency
---

# Inconsistent BBox Strategy for OSM Way Fetch

## What this is

When all points are cache hits, OSM ways are fetched using the full route bbox. When some points miss, the code fetches OSM ways for only the miss points' bbox.

## Problem

The two paths use different bboxes for the same operation. This is confusing and means the same route may fetch different OSM data depending on cache state.

## Fix

Add a comment explaining why the bboxes differ, or unify them to always use the full route bbox.

## If we skip it

Cache state affects which OSM data is fetched. Unlikely to cause issues but makes reasoning about behavior harder.
