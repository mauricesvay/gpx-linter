---
finding_id: 2
category: must_fix
severity: medium
component: src/reporter.ts
status: open
tags:
  - reporter
  - color
  - edge_case
---

# `process.stdout.isTTY` Check Crashes When Stdout Is Not a TTY

## What this is

`color === "auto" && Boolean(process.stdout.isTTY)` determines whether ANSI colors are emitted in text output.

## Problem

When stdout is redirected to a file, `isTTY` is `undefined` (falsy), so colors are correctly disabled. But this is fragile: if `process.stdout` is mocked in tests or a wrapper process, `isTTY` may not exist as a property, causing a crash.

## Fix

Add an explicit check: `process.stdout && "isTTY" in process.stdout && process.stdout.isTTY`.

## If we skip it

Tests that mock `process.stdout` without `isTTY` will crash. Unlikely in production but a sharp edge.
