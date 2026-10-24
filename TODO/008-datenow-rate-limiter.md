---
finding_id: 8
category: should_fix
severity: medium
component: src/osm/fetch.ts
status: open
tags:
  - network
  - rate_limit
  - time
---

# Rate Limiter Uses Wall Clock Which Can Go Backwards

## What this is

Rate limiting between Overpass chunks uses `Date.now()` to compute wait time.

## Problem

On systems with NTP adjustments, `Date.now()` can jump backward, causing `rateLimitWait` to be a huge positive number, stalling the entire run for seconds or minutes.

## Fix

Use `process.hrtime()` or track the last request time as a monotonic counter instead of wall clock.

## If we skip it

Rare but possible: a system clock adjustment causes the linter to hang for minutes waiting for "negative" wait times.
