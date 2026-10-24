---
finding_id: 23
category: nice_to_have
severity: info
component: src/utils.ts
status: superseded
tags:
  - lean
  - audit-correction
---

# `retryAfterMilliseconds` — false positive, actively used

## What this is

`retryAfterMilliseconds(value)` parses HTTP Retry-After headers. Used in `fetch.ts`.

## Problem

False positive from initial audit. This function is actively used.

## Fix

N/A — keep this function.
