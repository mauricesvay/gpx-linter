---
finding_id: 15
category: should_fix
severity: low
component: tests/
status: open
tags:
  - testing
  - gpx
  - edge_case
---

# No Test for Empty GPX File

## What this is

`parseGpx` throws "no trackpoints" for empty files. No test covers this edge case explicitly.

## Problem

The error path is untested. If the error message changes or the behavior shifts, no test will catch it.

## Fix

Add a test that passes an empty or minimal GPX file and verifies the error message.

## If we skip it

A regression in error handling for empty files goes unnoticed.
