---
finding_id: 26
category: should_fix
severity: medium
component: src/osm/fetch.ts
status: open
tags:
  - security
  - overpass
  - parsing
---

# Overpass Response Parsed Without Strict Validation

## What this is

`parseWays` in `fetch.ts` parses JSON responses from the Overpass API. It validates element types and geometry but does not validate tag values beyond `typeof tag === "string"`.

## Problem

Malformed or malicious OSM tags (e.g., extremely long tag values, null bytes) could cause memory issues or unexpected behavior downstream when embedded in reports.

## Fix

Add length limits on tag values (e.g., 1024 chars). Validate that geometry coordinates are within valid lat/lon ranges.

## If we skip it

A malformed Overpass response with extremely long tag values could cause memory pressure or encoding issues in reports.
