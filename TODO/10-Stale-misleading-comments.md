---
title: "P2-10: Stale / misleading comments"
priority: P2
category: "hygiene"
status: open
created: 2026-10-17
files:
  - src/rules/roadworks.ts
  - src/rules/max_slope.ts
  - src/linter.ts
  - src/engine.ts
  - src/config.ts
---

# P2-10: Stale / misleading comments

## Problem

- `src/rules/roadworks.ts:57` docs "buffer default: 5" — code/registry/default-config all say 1.
- `src/rules/max_slope.ts` doc prose says "default 25%" while its own param list says 10.
- `src/linter.ts` comment "config file path would come from options in a real CLI" — the CLI passes a loaded `LinterConfig`; the branch only runs for library users.
- Rule defaults are **triplicated**: registry `params` in `engine.ts` + `_DEFAULT_CONFIG` in `config.ts` + `numberParam` fallbacks in rule files. Derive all three from one `RULE_DEFAULTS` map.

## Fix

1. Update stale comment in `roadworks.ts` to match code (buffer = 1)
2. Fix `max_slope.ts` doc prose to "default 10%" (matching param list)
3. Remove or update the linter.ts CLI comment
4. Create a single `RULE_DEFAULTS` map and derive registry params, `_DEFAULT_CONFIG`, and `numberParam` fallbacks from it

## Files

- `src/rules/roadworks.ts` (line ~57)
- `src/rules/max_slope.ts` (doc comment)
- `src/linter.ts` (CLI comment)
- `src/engine.ts` (registry params)
- `src/config.ts` (`_DEFAULT_CONFIG`)
- All rule files with `numberParam` fallbacks
