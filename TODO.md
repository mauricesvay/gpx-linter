# gpx-linter — Architecture Review & Improvement TODO

## P0 — Bugs & Correctness (✅ All 5 items completed)

| # | Status | Commit |
|---|--------|--------|
| 1 | ✅ `confidenceFromScore` documented + tested | `80ec4ee` |
| 2 | ✅ `snapSinglePoint` extracted | `5f5cf0b` |
| 3 | ✅ Ambiguous results preserved | `5f5cf0b` |
| 4 | ✅ `registerRule` + `BUILTIN_RULES` registry | `c0762a2` |
| 5 | ✅ `deepFreeze` DEFAULT_CONFIG | `3c85aa2` |

### 1. ~~`confidenceFromScore` threshold is magic~~ ✅ DONE (commit `80ec4ee`)
`utils.ts:63` — `>=0.8` → high, `>=0.6` → medium, else low. No documentation or test coverage for these thresholds. Score calculation in `snapping.ts` weights distance 50%, bearing 30%, class 20%, continuity 0.2 bonus. The 0.15 ambiguity gap is also undocumented.

**Action:** Document thresholds. Add unit tests for boundary scores (0.59, 0.60, 0.79, 0.80, 0.85, 0.99).

### 2. ~~`enrichMatches` duplicates `snapPointsToWays` grid logic~~ ✅ DONE (commit `5f5cf0b`)
`snapping.ts` lines ~280-380 — `enrichMatches` copies the entire grid lookup, bbox rejection, candidate scoring, and ambiguity logic from `snapPointsToWays`. Any fix to one function must be manually mirrored.

**Action:** Extract a shared `snapSinglePoint(point, indexedWays, prevRoadId)` helper. Both functions call it.

### 3. ~~`resolveRoads` filters out ambiguous results silently~~ ✅ DONE (commit `5f5cf0b`)
`resolver/index.ts:130` — `ambiguous` results are filtered out entirely. The caller (CLI) never sees them. Users get "unmatched" instead of "ambiguous" — loses diagnostic value.

**Action:** Keep ambiguous results in the array. Let rules decide how to handle them.

### 4. ~~`engine.ts` hardcodes rule IDs in switch~~ ✅ DONE (commit `c0762a2`)
`engine.ts:33-48` — Adding a rule requires updating `RULES` map, the `switch` block, AND `rules/index.ts`. No compile-time safety. A misspelled rule ID silently disables the rule.

**Action:** Register rules via a `registerRule(id, handler)` function. Compile-time check via exported const `BUILTIN_RULES: Record<string, RuleHandler>`.

### 5. ~~`loadConfig` mutates DEFAULT_CONFIG via spread~~ ✅ DONE (commit `3c85aa2`)
`config.ts:75-77` — `structuredClone(DEFAULT_CONFIG)` is used, but `config.rules[id]` assignments mutate the cloned object's nested `params` objects. If DEFAULT_CONFIG.params is not deeply frozen, a second `loadConfig()` call could see mutated defaults.

**Action:** Deep-freeze DEFAULT_CONFIG or use a config factory function.

---

## P1 — Features

### 6. Implement `offline` routing backend
`--routing offline` currently errors: "No offline road-matching backend is configured." The `snapping.ts` module already does local geospatial snapping. The offline path just needs an offline OSM data source (pmtiles, local .osm.pbf).

**Action:** Add `offline` mode that reads a local OSM extract (pmtiles format, already a dependency) and runs `snapPointsToWays` against it.

### 7. Add `--dry-run` config validation
No way to validate a YAML config without processing a GPX file. Users get errors mid-run instead of upfront.

**Action:** Add `gpxlint check --dry-run --config gpxlint.yml`. Validates YAML, checks rule IDs exist, reports missing params.

### 8. Support multiple GPX files
CLI accepts only one file. Batch validation would be common (e.g., checking a whole tour).

**Action:** Change `<file>` argument to `<file...>`. Output a combined report or per-file reports.

### 9. No rate-limit handling beyond simple retry
`utils.ts:34` — `retryAfterMilliseconds` falls back to 1000ms if no Retry-After header. Overpass returns 429 with no header, then the code retries immediately — potentially hammering the server. No jitter.

**Action:** Implement exponential backoff with jitter (1s, 2s, 4s, 8s, cap 30s). Track per-endpoint rates.

### 10. No max-points limit
A malicious or accidental 1M+ point GPX will freeze the process. OSM fetching alone will timeout.

**Action:** Add `--max-points` (default 50,000). Reject GPX files exceeding the limit with a clear error.

### 11. Add `--version` flag
`package.json` has `"version": "1.0.0"` but no CLI query.

**Action:** Commander `.version()` call.

### 12. No CI lint step
`npm run lint` exists (Biome) but is not in `npm run check`. No CI integration.

**Action:** Add `npm run lint` to the `check` script.

---

## P2 — Code Quality

### 13. ~~`engine.ts` is 80 lines, CLI is 180+ lines~~ ✅ DONE (commit `6c3b846`)
`cli.ts` handles config loading, file reading, OSM fetching, road matching, rule evaluation, report creation, formatting, AND file writing. Single responsibility violated.

**Action:** Extract a `Linter` class or `runLinter(file, config, options)` function that orchestrates the pipeline. CLI becomes a thin wrapper.

### 14. ~~`snapping.ts` is 530 lines~~ ✅ DONE (commit `bc07cb6`)
Grid building, scoring, direction resolution, ambiguity detection, and enrichment all in one file.

**Action:** Split into `snapping.ts` (core snapping), `enrichment.ts` (OSM enrichment), `index.ts` (re-exports).

### 15. `htmlTemplate.ts` XSS vulnerability
`JSON.stringify(report)` embeds raw JSON into `<script>` tags. If `routeName` or any `message` contains `</script>`, it breaks the HTML. `escapeHtml` is not used on embedded JSON strings.

**Action:** Use CDATA sections or base64-encode the JSON payload. Or use `textContent`-safe encoding.

### 16. No TypeScript module exports audit
`src/index.ts` re-exports everything including internal types (`DataSourceAvailability`, `CacheStats`, `TrackCoordinate`). Consumers may depend on implementation details that change.

**Action:** Create an explicit `public-api.ts` barrel file. Export only the public contract.

### 17. `DEFAULT_CONFIG` rules use `Object.freeze` but nested objects are not frozen
`config.ts:17` — `Object.freeze(DEFAULT_CONFIG)` only shallowly freezes. `DEFAULT_CONFIG.rules.max_slope.params` is still mutable.

**Action:** Use a deep-freeze utility or a config factory.

### 18. Duplicate constants across modules
`MAX_SNAP_DISTANCE_METERS`, `GRID_CELL_DEGREES`, `AMBIGUITY_GAP_METERS`, `OVERPASS_TTL_MS` are defined in `cache.ts` but used across `snapping.ts`, `resolver/index.ts`, and `resolver/overpass.ts`. If one constant changes, all consumers must be verified.

**Action:** Centralize constants in `constants.ts`.

---

## P3 — Architecture & DX

### 19. No changelog or semantic versioning
**Action:** Add `CHANGELOG.md` with initial release notes. Configure conventional commits.

### 20. Spec document (`gpx-route-linter-spec.md`) is orphaned
59KB spec not referenced from README.

**Action:** Link from README or trim to a summary.

### 21. Hard-coded Earth radius
`geo.ts:3` — `EARTH_RADIUS_METERS = 6_371_000`. WGS84 mean radius. No comment.

**Action:** Add JSDoc comment. Consider a configurable radius for non-Earth use (niche but clean).

### 22. No input validation for GeoJSON
`roadworks.ts` reads a GeoJSON file but no schema validation. Malformed GeoJSON silently produces no results.

**Action:** Validate GeoJSON structure at load time. Report clear errors.

### 23. No editor config
**Action:** Add `.editorconfig` for consistent indentation, line endings.

### 24. Cache format is opaque
Cache stores `{ storedAt: number; result: MatchResult }`. No versioning. Future schema changes break old cache files.

**Action:** Add `version: string` to cache entries. Handle version mismatches gracefully.

---

## Quick Wins (5 min each)

| # | Change | Effort |
|---|--------|--------|
| A | Add `gpxlint --version` | Low |
| B | Add `npm run lint` to `check` script | Low |
| C | Add `CHANGELOG.md` | Low |
| D | Add `--max-points` CLI option (default 50000) | Low |
| E | Document `--routing offline` behavior in README | Low |
| F | Add `.editorconfig` | Low |
| G | Extract shared grid lookup from `snapPointsToWays` + `enrichMatches` | Medium |
| H | Create `constants.ts` from cache.ts scattered constants | Low |
| I | Add `--dry-run` config validation | Medium |
| J | Fix XSS in HTML report (CDATA encoding) | Low |
