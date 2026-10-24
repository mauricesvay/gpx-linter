---
finding_id: 13
category: should_fix
severity: low
component: tests/
status: open
tags:
  - testing
  - integration
  - html
---

# No Integration Test for Full CLI Pipeline with HTML Output

## What this is

The CLI test uses `--format json` only. HTML output (which involves external CDN fetches) is only tested in `report.test.ts` with a mocked `fetch`.

## Problem

No end-to-end test validates the complete CLI → linter → reporter flow with HTML output. Edge cases in the full pipeline (cache + resolver + OSM + reporter) are untested.

## Fix

Add an integration test that runs `runCheck` with `--format html` and verifies the output file is valid HTML.

## If we skip it

A regression in the full pipeline (e.g., a breaking change in how the reporter uses resolver data) won't be caught by the CLI test suite.
