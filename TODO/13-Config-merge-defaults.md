---
title: "P1-13: Config defaults are not normalized before rule evaluation"
priority: P1
category: "correctness"
status: open
created: 2026-10-18
files:
  - src/config.ts
  - src/linter.ts
  - src/engine.ts
---

# P1-13: Config defaults are not normalized before rule evaluation

## Problem

`src/config.ts` applies YAML overrides and merges rule-specific settings, but `src/linter.ts` and `src/engine.ts` still rely on a partially shaped `config.rules` object during runtime.

This creates a correctness gap when callers pass a custom config with only a subset of rules or omit nested values. The `enabled()` helper checks only whether a rule key exists and whether `enabled !== false`, which can silently skip expected defaults if the object is not fully normalized before use.

The result is inconsistent rule behaviour across entry points and more brittle custom configuration handling.

## Why it matters

- Disabled or missing rules may be treated as absent rather than default-enabled.
- Rule metadata and defaults can drift between runtime paths.
- Config overrides may appear to work but quietly change semantics in edge cases.

## Fix

1. Normalize the loaded config against `DEFAULT_CONFIG` before rule execution.
2. Merge `config.rules` deeply from defaults, then overlay validated user inputs.
3. Validate rule definition objects before running any rule handlers.
4. Keep explicit `enabled: false` and `enabled: true` semantics, but fail clearly on unknown rule IDs.

## Files

- `src/config.ts`
- `src/linter.ts`
- `src/engine.ts`
