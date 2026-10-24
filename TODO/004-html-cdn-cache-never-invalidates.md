---
finding_id: 4
category: should_fix
severity: medium
component: src/htmlTemplate.ts
status: open
tags:
  - html
  - caching
  - network
---

# HTML CDN Scripts Cached Forever in Module-Level Variable

## What this is

`_scriptsPromise` is a module-level variable that caches the result of fetching 3 CDN scripts.

## Problem

If the CDN URLs change or the scripts break, the cached promise will keep failing for every subsequent run until the process restarts. There's no way to invalidate the cache.

## Fix

Make `_scriptsPromise` nullable and re-fetch on failure, or add a TTL.

## If we skip it

A broken CDN link breaks all future HTML reports until the CLI process restarts.
