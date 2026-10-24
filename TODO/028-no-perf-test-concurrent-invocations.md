---
finding_id: 28
category: should_fix
severity: low
component: src/
status: open
tags:
  - performance
  - concurrency
---

# No Performance Test for Concurrent CLI Invocations

## What this is

The linter is a CLI tool, so concurrent invocations are possible (e.g., a script checking many files in parallel).

## Problem

The HTML template module caches a global `_scriptsPromise`. If two concurrent CLI invocations call `formatHtml` simultaneously, they share the same promise — which is fine. But the file cache writes from multiple processes could race.

## Fix

Test concurrent invocations. Verify cache file writes are atomic (write to temp, rename).

## If we skip it

Two concurrent invocations writing cache files simultaneously could corrupt the cache.
