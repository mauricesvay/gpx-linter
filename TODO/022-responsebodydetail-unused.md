---
finding_id: 22
category: nice_to_have
severity: info
component: src/utils.ts
status: superseded
tags:
  - lean
  - audit-correction
---

# `responseBodyDetail` — false positive, actively used

## What this is

`responseBodyDetail(body, maxLength)` parses an HTTP response body for error details. Used in `fetch.ts`.

## Problem

False positive from initial audit. This function is actively used.

## Fix

N/A — keep this function.
