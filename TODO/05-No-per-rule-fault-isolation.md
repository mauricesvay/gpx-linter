---
title: "P1-05: No per-rule fault isolation"
priority: P1
category: "contract"
status: open
created: 2026-10-17
files:
  - src/engine.ts
---

# P1-05: No per-rule fault isolation in `evaluateRules`

## Problem

`src/engine.ts` — a throwing handler aborts the whole run with exit 3. `roadworks` handles ENOENT, but a *malformed* GeoJSON file (bad JSON / rings) throws inside `isWithinFeature`/parsing and kills every other rule.

## Fix

Wrap each handler in try/catch → emit `unknown` with the error message. Matches the stated philosophy and makes user-supplied data untrusted-safe.

```ts
// In evaluateRules, inside the handler loop:
try {
  results.push(...(await handler(definition, points, context || {})));
} catch (err) {
  results.push(result(
    ruleId, definition, metadata.defaultSeverity, "unknown",
    `Rule "${ruleId}" failed: ${errorMessage(err)}`,
    "low",
  ));
}
```

## Files

- `src/engine.ts` (`evaluateRules` function)
