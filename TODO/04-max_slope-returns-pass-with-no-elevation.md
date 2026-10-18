---
title: "P1-04: max_slope returns pass with no elevation"
priority: P1
category: "contract"
status: done
created: 2026-10-17
files:
  - src/rules/max_slope.ts
---

# P1-04: `max_slope` returns `pass`/high on a route with no elevation data

## Problem

`src/rules/max_slope.ts:89` — when every pair is skipped (`checked === 0`), the rule falls through to `pass`/high. That contradicts the README's own contract: *"Unavailable or ambiguous inputs produce `unknown`, not a pass."*

You already have `checked` in evidence — emit `unknown` with `checkedSegments: 0` when `checked === 0`. (Current mitigation: `missing_elevation` fails and exit code 2 via gpx availability, but the report line still shows a green pass.)

## Fix

```ts
if (results.length === 0) {
  if (checked === 0) {
    // Emit unknown instead of pass when no segments could be checked
    results.push(result(
      "max_slope", definition, "error", "unknown",
      "No segments could be evaluated (no elevation data or all within-segment points skipped).",
      "high", undefined, { checkedSegments: 0, thresholdPercentage: threshold },
    ));
  } else {
    // Original pass result
    results.push(result(
      "max_slope", definition, "error", "pass",
      `No within-segment slopes exceed the ${threshold}% limit.`,
      "high", undefined, { checkedSegments: checked, thresholdPercentage: threshold },
    ));
  }
}
```

## Files

- `src/rules/max_slope.ts` (lines ~80-95)
