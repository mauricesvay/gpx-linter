# gpx-linter — Improvement TODO

## P0 — Bug fixes

### 1. ~~Geo distance uses wrong coordinate order~~ ✅ FIXED
Internal code consistently uses `{lat, lon}` objects (Trackpoint type). GeoJSON `[lon, lat]` arrays are converted at boundaries. `isPosition` validates GeoJSON coords correctly. No bug.

### 2. ~~`skipLibCheck: false` in tsconfig~~ ✅ FIXED
Set `skipLibCheck: true` in tsconfig.json.

### 3. ~~`leaflet` types as production dependency~~ ✅ FIXED
Moved `@types/leaflet` from `dependencies` to `devDependencies`.

### 4. ~~Version mismatch: vite 8.x vs vitest 5.x~~ ✅ FIXED
Vitest 5.0.3 peerDep already supports Vite 8: `'^6.4.0 || ^7.0.0 || ^8.0.0'`. Versions aligned.

---

## P1 — Features

### 5. Implement `offline` routing backend
`--routing offline` currently prints "No offline road-matching backend is configured." The spec mentions turf.js should be used for local geospatial operations. Consider bundling a lightweight OSM tile/extraction approach or at least a better error message.

### 6. Add `--version` flag
CLI says `"version": "1.0.0"` but no way to query it.

**Fix:** Add `gpxlint --version` via Commander.

### 7. Config file validation — allow unknown rule IDs
The engine currently emits "unknown" for any rule ID not in `RULES`. Users can define custom rules in YAML but get no feedback. Consider a `--dry-run` flag that validates config without processing a GPX file.

### 8. Support multiple GPX files
CLI only accepts one file. Add `gpxlint check file1.gpx file2.gpx` support.

---

## P2 — Code quality

### 9. Large files — split `osm.ts` (480+ lines)
`osm.ts` handles bbox logic, Overpass fetching, caching, point snapping, direction resolution, and enrichment. Split into `osm/fetch.ts`, `osm/snapping.ts`, `osm/cache.ts`.

### 10. Duplicate code in `resolveRoads` and `enrichMatches`
Both functions build a grid index from OSM ways and iterate the same 3×3 neighbor cells. Extract to a shared `findNearbyWays()` helper.

### 11. `engine.ts` switch statement is fragile
Adding a rule requires updating 3 places: the `RULES` map, the `switch` block, and the rules index. Create a registration system or map of rule handlers.

### 12. Missing elevation smoothing doesn't handle null neighbors
`smoothElevations` uses `point.ele` as fallback when neighbors are null. This can produce a spike if the center point is valid but both neighbors are null. Consider a 5-point window or interpolation.

### 13. No input validation for extremely large GPX files
A GPX with 1M+ points will freeze the process. Add a configurable max-point limit with a clear error.

### 14. `htmlTemplate.ts` inline JS is XSS-vulnerable
While `escapeHtml` is used for string interpolation, the inline script embeds `trackJson` and `findingsJson` via `JSON.stringify` without sanitizing string values in `message`. If a route name contains `</script>`, it breaks the HTML.

**Fix:** Use a `<script>`-safe encoding or base64-encode the JSON data.

---

## P3 — Architecture & DX

### 15. No ESLint — only Biome
Biome is configured but no CI lint step exists. Add `npm run lint` to CI.

### 16. No changelog or semantic versioning
Add a CHANGELOG.md and configure conventional commits.

### 17. Spec document (`gpx-route-linter-spec.md`) is 59KB and orphaned
It's not referenced anywhere. Either link it from README or trim to a summary.

### 18. No TypeScript module exports test
`src/index.ts` re-exports everything. Verify all exports are intentional (e.g., `DEFAULT_CONFIG`, `DEFAULT_CONFIG.rules` internals). Consider a barrel file per module.

### 19. Hard-coded Earth radius
`EARTH_RADIUS_METERS = 6_371_000` is used everywhere. Define as a constant with a comment noting it's WGS84 mean radius. Consider allowing a configurable radius for non-Earth use.

### 20. No rate-limit handling beyond simple retry
Overpass can return 429 with no `Retry-After` header. The code falls back to 1000ms. Add exponential backoff with jitter.

---

## Quick wins (5 min each)

| # | Change |
|---|--------|
| A | Remove `@types/leaflet` from deps → devDeps |
| B | Set `skipLibCheck: true` in tsconfig |
| C | Add `gpxlint --version` CLI flag |
| D | Add `npm run lint` to `npm run check` script |
| E | Add `CHANGELOG.md` with initial release notes |
| F | Add `--max-points` CLI option (default 50000) |
| G | Document `--routing offline` behavior in README |
| H | Add `prettier`-like `.editorconfig` for editor consistency |
