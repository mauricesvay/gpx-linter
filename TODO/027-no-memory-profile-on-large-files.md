---
finding_id: 27
category: should_fix
severity: low
component: src/
status: open
tags:
  - performance
  - profiling
---

# No Memory Profiling on 50,000-Point Files

## What this is

The linter supports up to 50,000 trackpoints (`DEFAULT_MAX_TRACK_POINTS`). No memory profiling has been done on files near this limit.

## Problem

Without profiling, we don't know if the linter stays within reasonable memory bounds (e.g., <512MB) for max-size files. The resolver creates intermediate arrays, the snapping module builds indexes, and the reporter creates HTML strings — all linear in input size but with unknown constants.

## Fix

Profile memory usage on a 50k-point file. Set an alert threshold if memory exceeds 1GB.

## If we skip it

A user with a large GPX file might hit OOM on constrained systems (e.g., containers with 512MB limits).
