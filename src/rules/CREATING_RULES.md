# Creating a New Rule

This document describes the pattern for adding a new rule to the gpx-linter.

## Overview

Each rule is a single TypeScript file in `src/rules/` that exports a handler function. The rule is registered in `src/engine.ts` and optionally re-exported from `src/rules/index.ts`.

## File Structure

```
src/rules/my_new_rule.ts
```

A rule file contains:

1. **Zod parameter schema** — validates user-configurable parameters.
2. **Type inference** — derives a params input type from the schema.
3. **Handler function** — the core logic that evaluates trackpoints.

## Step-by-Step

### 1. Create the handler file

Create `src/rules/my_new_rule.ts` with this structure:

```typescript
import { z } from "zod";

import type {
  RuleDefinition,
  RuleResult,
  Trackpoint,
} from "../types";
import { numberParam, result } from "./utils";

/** Zod schema for my_new_rule parameters. */
export const myNewRuleParamsSchema = z.object({
  my_configurable_param: z.number().optional(),
});

/** Infer params type from schema. */
export type MyNewRuleParamsInput = z.infer<typeof myNewRuleParamsSchema>;

/**
 * Description of what the rule does.
 *
 * @param definition — rule definition containing severity, params, and enabled flag
 * @param points   — ordered trackpoints from the GPX file
 * @returns array of rule results
 */
export function myNewRule(
  definition: RuleDefinition,
  points: Trackpoint[],
): RuleResult[] {
  const param = numberParam(definition, "my_configurable_param", 42);

  // Your rule logic here...

  // Return results using the result() helper:
  return [
    result(
      "my_new_rule",           // rule ID (matches engine registration)
      definition,
      "error",                 // default severity (overridden by config)
      "pass",                  // "pass" | "fail" | "unknown" | "skipped"
      "Descriptive message.",  // human-readable output
      "high",                  // confidence: "high" | "medium" | "low"
      undefined,               // optional: Trackpoint for point-level results
      { myField: 123 },        // optional: evidence for JSON reports
    ),
  ];
}
```

### 2. Register the rule in `src/engine.ts`

Add a `registerRule` call in the built-in rules section:

```typescript
registerRule("my_new_rule", {
  defaultSeverity: "error",      // "error" | "warning" | "info"
  requiresRoads: false,          // true if the rule needs road-matching data
  enabledByDefault: false,       // whether the rule is on by default
  description: "What the rule checks.",
  params: { my_configurable_param: 42 },  // default param values
}, (def, pts, ctx) => myNewRule(def, pts));
```

Key fields:

| Field | Description |
|---|---|
| `id` | Unique rule identifier (used in GPX linter config). |
| `defaultSeverity` | Fallback severity when not specified in user config. |
| `requiresRoads` | `true` if the rule depends on road-matching results. |
| `enabledByDefault` | `true` if the rule runs without explicit config. |
| `description` | Human-readable description shown in reports. |
| `params` | Default parameter values (mirrors the Zod schema). |

### 3. Export from `src/rules/index.ts`

Add exports so the rule is accessible:

```typescript
// Handler export
export { myNewRule } from "./my_new_rule";

// Params schema export (for config validation)
export { myNewRuleParamsSchema } from "./my_new_rule";

// Params type export (for TypeScript consumers)
export type { MyNewRuleParamsInput } from "./my_new_rule";
```

Update the JSDoc comment at the top of `index.ts` to list the new rule.

### 4. Update types (if needed)

If the rule introduces new parameter types, add an interface to `src/types.ts`:

```typescript
export interface MyNewRuleParams {
  my_configurable_param?: number;
}
```

Add it to the `RuleParams` union type.

## Conventions

- **Rule IDs**: kebab-case (e.g. `max_slope`, `sharp_turn`).
- **Handler names**: camelCase matching the rule ID (e.g. `maxSlope`).
- **Schema names**: camelCase + `ParamsSchema` suffix.
- **Type names**: PascalCase + `ParamsInput` suffix.
- Use `numberParam()` from `./utils` to read numeric parameters with fallbacks.
- Use `result()` from `./utils` to construct `RuleResult` objects.
- Rules that need road-matching data accept a `RuleContext` parameter:
  ```typescript
  export function myRule(
    definition: RuleDefinition,
    points: Trackpoint[],
    ctx: RuleContext,
  ): RuleResult[] { ... }
  ```
- Always return at least one result (even if "skipped" or "unknown").

## Available Helpers (`src/rules/utils.ts`)

| Helper | Purpose |
|---|---|
| `result()` | Build a `RuleResult` object |
| `numberParam()` | Read a numeric param with fallback |
| `sameSegment()` | Check if two points share a segment |
| `smoothElevations()` | Median-filter elevation data |
| `hasBikeContraflow()` | Detect contraflow cycling on OSM roads |
| `isOneWay()` / `isTwoWay()` | Classify OSM `oneway` tags |
| `isFeatureCollection()` | Type guard for GeoJSON FeatureCollections |
| `isConfidentMatch()` | Check if a road match is usable |
| `uncertaintyResult()` | Build an `unknown` result for non-confident matches |
| `buildSummaryResult()` | Assemble per-point results + pass summary |

## Testing

Add tests in the corresponding test file under `src/rules/` or the main test suite. Test:

- Normal pass/fail scenarios.
- Edge cases (empty points, missing elevation, boundary parameters).
- Parameter overrides via `RuleDefinition.params`.
