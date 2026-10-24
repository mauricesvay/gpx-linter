---
finding_id: 16
category: nice_to_have
severity: info
component: src/config.ts
status: open
tags:
  - lean
  - dead_code
---

# Remove `deepFreeze` — 12 lines of dead code

## What this is

`deepFreeze` in `config.ts` recursively freezes all nested objects in `DEFAULT_CONFIG`.

## Problem

`structuredClone` in `loadConfig` already creates a deep copy. The freeze adds ~2ms per startup with no measurable benefit.

## Fix

Remove `deepFreeze` and `_DEFAULT_CONFIG` prefix. Export the config directly.

## Lean

-12 lines.
