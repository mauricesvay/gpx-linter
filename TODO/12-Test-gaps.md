---
title: "P2-12: Test gaps"
priority: P2
category: "quality"
status: open
created: 2026-10-17
files:
  - tests/geo.test.ts
  - tests/resolver.test.ts
  - tests/linter.test.ts
---

# P2-12: Test gaps (beyond #1)

## Problem

- No test for roadworks missing-file → `unknown`
- No resolver-cache tests (TTL expiry, growth, exact-key behavior)
- `tests/linter.test.ts` has 1 test — the pipeline's provider routing (offline vs overpass, `fetchOsmWays` selection, exit-code mapping) is the most branching code in the repo and barely covered

## Fix

Add tests for:

1. **Roadworks missing file** → rule result is `unknown`, not crash
2. **Resolver cache TTL expiry** — entries past TTL are not returned
3. **Resolver cache growth** — old entries are pruned on write
4. **Resolver cache exact-key quantization** — nearby coordinates produce cache hits
5. **Linter pipeline** — offline vs overpass provider routing, `fetchOsmWays` selection, exit-code mapping (0/1/2/3)
6. **Regression test for #1** — two bboxes sharing a grid origin produce different keys

## Files

- `tests/geo.test.ts` (add bbox/key tests)
- `tests/resolver.test.ts` (new file for resolver cache)
- `tests/linter.test.ts` (expand from 1 test)
