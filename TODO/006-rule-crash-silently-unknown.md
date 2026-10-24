---
finding_id: 6
category: should_fix
severity: medium
component: src/engine.ts
status: open
tags:
  - engine
  - error_handling
  - debugging
---

# Rule Crashes Silently Reported as "Unknown"

## What this is

When a rule handler throws, the error is caught and a single "unknown" result is emitted for that rule.

## Problem

If a rule crashes (e.g., a bug in `max_slope`), the user sees "unknown" and has no idea the rule crashed. The error message is included but buried in a single finding. The crash is silently swallowed.

## Fix

Log the error to stderr (as a warning) in addition to emitting the unknown result, so the user knows a rule crashed rather than just passed/failed.

## If we skip it

A bug in a rule produces "unknown" status. The user assumes incomplete data rather than a code error, making debugging harder.
