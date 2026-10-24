---
finding_id: 17
category: nice_to_have
severity: info
component: src/utils.ts
status: open
tags:
  - lean
  - dead_code
---

# Remove unused `message` alias

## What this is

`export const message = errorMessage;` in `utils.ts` is imported by `resolver/index.ts` but never used elsewhere.

## Problem

Dead export. If `resolver/index.ts` were refactored, this alias would become truly dead code.

## Fix

Remove the alias. Replace the single import site with `errorMessage`.

## Lean

-1 line.
