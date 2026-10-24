---
finding_id: 5
category: should_fix
severity: low
component: src/gpxParser.ts
status: open
tags:
  - performance
  - gpx
---

# Elevation Gain and Max Gradient Computed in Separate Passes

## What this is

`parseGpx` computes `distanceFromStart` for every point in one pass. Then `calculateElevationGain` and `calculateMaxGradient` are called separately, each re-iterating all points.

## Problem

For a 50,000-point file, elevation gain and max gradient are each computed in a full pass after the main parse pass. This triples the work.

## Fix

Compute elevation gain and max gradient during the main parse loop instead of calling separate functions.

## If we skip it

Parsing a 50k-point file takes ~3× longer than necessary. Acceptable for occasional use but noticeable at scale.
