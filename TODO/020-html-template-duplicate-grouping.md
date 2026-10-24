---
finding_id: 20
category: nice_to_have
severity: info
component: src/htmlTemplate.ts, src/reporter.ts
status: open
tags:
  - lean
  - duplication
---

# `groupContiguousResults` duplicated in htmlTemplate.ts and reporter.ts

## What this is

Both `htmlTemplate.ts` and `reporter.ts` implement `groupContiguousResults` with nearly identical logic: filter indexed results, sort by index, group contiguous ranges.

## Problem

Two copies of the same logic. A bug fix in one must be manually applied to the other.

## Fix

Extract to a shared helper in `reporter.ts` and import from `htmlTemplate.ts`.

## Lean

-25 lines (one copy removed).
