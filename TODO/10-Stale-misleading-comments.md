---
title: "P2-10: Stale / misleading comments"
priority: P2
category: "hygiene"
status: done
created: 2026-10-17
resolved: 2026-01-XX
files:
  - src/rules/roadworks.ts
  - src/rules/max_slope.ts
  - src/linter.ts
  - src/engine.ts
  - src/config.ts
  - src/rules/constants.ts (new)
---

# P2-10: Stale / misleading comments

## Problem

- `src/rules/roadworks.ts:57` docs "buffer default: 5" — code/registry/default-config all say 1.
- `src/rules/max_slope.ts` doc prose says "default 25%" while its own param list says 10.
- `src/linter.ts` comment "config file path would come from options in a real CLI" — the CLI passes a loaded `LinterConfig`; the branch only runs for library users.
- Rule defaults are **triplicated**: registry `params` in `engine.ts` + `_DEFAULT_CONFIG` in `config.ts` + `numberParam` fallbacks in rule files. Derive all three from one `RULE_DEFAULTS` map.

## Fix Applied

1. Fixed stale comment in `roadworks.ts`: "default: 5" → "default: 1"
2. Fixed `max_slope.ts` doc prose: "default 25%" → "default 10%"
3. Removed misleading CLI comment in `linter.ts`
4. Created `src/rules/constants.ts` with a single `RULE_DEFAULTS` map containing all rule parameter defaults
5. Updated `engine.ts` registry `params` to reference `RULE_DEFAULTS.*`
6. Updated `config.ts` `_DEFAULT_CONFIG` to derive params from `RULE_DEFAULTS`
7. Updated all rule files (`max_slope.ts`, `roadworks.ts`, `sharp_turns.ts`, `off_road.ts`, `missing_elevation.ts`, `route_gaps.ts`, `loop_closure.ts`) to import and use `RULE_DEFAULTS` for `numberParam` fallbacks

## Files

- `src/rules/roadworks.ts` (comment fixed)
- `src/rules/max_slope.ts` (comment fixed)
- `src/linter.ts` (comment removed)
- `src/engine.ts` (registry params → RULE_DEFAULTS)
- `src/config.ts` (_DEFAULT_CONFIG → RULE_DEFAULTS)
- `src/rules/constants.ts` (new — single source of truth)
- `src/rules/sharp_turns.ts`, `src/rules/off_road.ts`, `src/rules/missing_elevation.ts`, `src/rules/route_gaps.ts`, `src/rules/loop_closure.ts` (numberParam → RULE_DEFAULTS)
