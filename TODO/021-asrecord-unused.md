---
finding_id: 21
category: nice_to_have
severity: info
component: src/utils.ts
status: open
tags:
  - lean
  - dead_code
---

# Remove unused `asRecord`

## What this is

`asRecord(value)` is a thin wrapper around `isRecord` that returns `null` instead of `false`. It is never imported or called.

## Problem

Dead function.

## Fix

Remove `asRecord`.

## Lean

-3 lines.
