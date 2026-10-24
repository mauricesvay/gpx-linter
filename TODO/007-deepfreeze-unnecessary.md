---
finding_id: 7
category: should_fix
severity: low
component: src/config.ts
status: open
tags:
  - config
  - dead_code
  - lean
---

# `deepFreeze` Adds Overhead With No Measurable Benefit

## What this is

`deepFreeze` recursively freezes all nested objects in `DEFAULT_CONFIG`.

## Problem

This is unnecessary for a config object that is never mutated after creation. `structuredClone` in `loadConfig` already creates a deep copy. The freeze adds ~2ms per startup with no measurable benefit. If a third-party library ever returns a non-frozen object from a rule definition, `deepFreeze` throws.

## Fix

Remove `deepFreeze`. The config is never mutated after `loadConfig` returns a clone.

## If we skip it

~12 lines of dead code. Minor startup slowdown.
