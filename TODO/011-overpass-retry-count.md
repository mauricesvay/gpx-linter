---
finding_id: 11
category: should_fix
severity: low
component: src/osm/fetch.ts
status: open
tags:
  - network
  - overpass
  - reliability
---

# Only One Retry on Transient Overpass Failure

## What this is

`requestOverpass` retries once (2 attempts total) on network failure, and once on 429/5xx.

## Problem

Overpass API can be slow during peak hours. One retry may not be enough. The exponential backoff is only applied on the second attempt (attempt=1), not the first failure.

## Fix

Apply backoff on the first retry too, or increase max retries to 3.

## If we skip it

Occasional failures during peak Overpass hours result in "unavailable" status when a few more retries would have succeeded.
