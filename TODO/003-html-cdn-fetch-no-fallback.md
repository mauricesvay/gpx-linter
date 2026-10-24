---
finding_id: 3
category: must_fix
severity: medium
component: src/htmlTemplate.ts
status: open
tags:
  - html
  - network
  - error_handling
---

# HTML Report Generation Fails When CDN URLs Go Down

## What this is

`getPlugins()` calls `fetch()` on 3 CDN URLs (leaflet.geometryutil, distance-markers, their CSS) and caches the promise in `_scriptsPromise`. This happens the first time `formatHtml` is called.

## Problem

If the CDN URLs go down (unpkg, raw.githubusercontent.com), the entire HTML report generation fails with an unhandled promise rejection. There's no fallback, and no timeout. For a CLI tool, a network failure should not crash report generation.

## Fix

Wrap the fetch in a try/catch and fall back to inline stubs (empty scripts/CSS) when CDN fetch fails. Add a 5-second timeout.

## If we skip it

Users generating HTML reports when the CDN is unreachable get a crash instead of a report.
