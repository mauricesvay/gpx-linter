# GPX Route Linter — Specification

> **Goal:** A configurable rule-based linter that validates GPX bike routes against a set of checks (slope, infrastructure, road works, etc.).

**Architecture:** CLI-first tool that loads a GPX file, resolves trackpoints to road network segments (via OSRM/GraphHopper/Overpass), and runs a pluggable rule engine. Rules are declared in a YAML config — add, remove, or disable them without code changes.

**Tech Stack:**
- **TypeScript 5+** (Node.js 20+)
- `gpx` npm package (GPX XML parsing) or manual XML parsing with `fast-xml-parser`
- `@turf/turf` (haversine, bearing, point-to-line distance, buffer, booleanWithin)
- `@types/node` (native `fetch`, `Buffer`, `fs`)
- GraphHopper or OSRM for road network resolution
- `js-yaml` for rule config
- `commander` for CLI

---

## Core Concepts

### 1. GPX Input
- Parse `.gpx` file → list of trackpoints (lat, lon, ele?, time?)
- Handle multiple tracks/segments
- Output: list of GeoJSON Point-like objects with optional elevation

### 2. Road Network Resolution
Each trackpoint must be "snapped" to the road network to enable infrastructure checks.
- **Approach:** Use a dedicated matching pipeline, not a simple nearest-road lookup. For each point, generate candidate road segments, score them, and assign a confidence level.
- **Default matching strategy:** nearest-segment + geometric tolerance + heading continuity + topology continuity + bike-specific plausibility.
- Output per point: `{lat, lon, road_id, matchConfidence, score, osm_tags, road_name, oneway, bicycle, designation, surface, highway, maxspeed, tunnel, ...}`
- This is the bridge between raw GPS coords and semantic infrastructure data.

#### Map-matching and confidence model
Map-matching is a first-class concern and is not optional. The system will explicitly model uncertain matches rather than assuming every nearby road is correct.

**Pipeline:**
1. Build candidate roads within a search radius around the point.
2. Score each candidate using weighted factors:
   - distance to road edge
   - heading agreement with previous/next point
   - continuity with the neighboring matched roads
   - road class / bike plausibility
   - topology / connectedness
3. Select the best candidate if the score clears the threshold.
4. If multiple candidates are too close in score, mark the result as `ambiguous`.
5. Rule evaluation only proceeds when the match confidence is sufficient for that rule.

**Confidence levels:**
- `high`: strong match, suitable for safety-critical rules and OSM enrichment
- `medium`: usable for moderate-confidence checks
- `low`: route is likely matched, but not precise enough for hard violations
- `unknown`: no reliable match, or no candidate found

**Rule gating:**
- Safety-critical rules (R2, R5, R19, R20) require `medium` or `high`
- Route-quality checks may allow `low`
- `unknown` results are surfaced as data-quality findings and must not silently pass as compliant

**Ambiguous cases:**
- parallel road / lane / cycleway conflicts
- service roads vs main roads
- underpasses / overpasses
- sidewalk or path edges near roads
- GPS jitter near intersections

When a point is ambiguous, the system must keep the candidate set and mark the result as `ambiguous` instead of forcing a wrong road match.

```ts
interface MatchResult {
  status: 'matched' | 'ambiguous' | 'unmatched'
  confidence: 'high' | 'medium' | 'low' | 'unknown'
  score: number
  roadId?: string
  roadName?: string
  distanceToRoad?: number
  reason?: string
  candidates?: Array<{
    roadId: string
    score: number
    highway?: string
    distanceToRoad?: number
  }>
}
```

**Rule result model:**
Every rule must return a structured outcome, not a raw boolean.

```ts
interface RuleResult {
  status: 'pass' | 'fail' | 'unknown' | 'skipped'
  confidence: 'high' | 'medium' | 'low'
  reason?: string
  evidence?: Record<string, unknown>
}
```

This distinguishes:
- definitely violated
- definitely compliant
- insufficient data or ambiguous map match
- rule disabled or not applicable

### 2b. Overpass API Integration (OSM Data Access)

For rules that need OSM metadata (surface, bicycle, highway, tunnel, maxspeed), use the **Overpass API** — a free, public API that returns only the OSM elements you request. No local download needed.

**Public instances:** `https://overpass-api.de/api/` (primary), `https://overpass.kumi.systems/api/` (fallback)

**Pattern: Geofilter bounding box**
For every rule, compute the route's bounding box, then query only OSM data within that box. This keeps responses small and fast.

```typescript
// Compute bounding box from route (with 0.5km padding)
const latMin = Math.min(...latitudes) - 0.005
const lonMin = Math.min(...longitudes) - 0.005
const latMax = Math.max(...latitudes) + 0.005
const lonMax = Math.max(...longitudes) + 0.005
const bbox = `${latMin},${lonMin},${latMax},${lonMax}`
```

**Per-rule Overpass queries:**

#### R2: Contraflow Bike Lane Violation
Query roads with `oneway` tag, then check `bicycle` and `cycleway` tags:

```
[out:json][timeout:25];
(
  way({bbox})["highway"]["oneway"];
  way({bbox})["highway"]["oneway"]["bicycle"];
  way({bbox})["highway"]["oneway"]["cycleway"];
  way({bbox})["highway"]["oneway"]["cycleway:left"];
  way({bbox})["highway"]["oneway"]["cycleway:right"];
);
out body;
>;
out skel qt;
```
Returns all one-way roads in the area with their bike/cycleway tags. The rule checks each trackpoint's matched road segment against this data.

#### R10: Surface Type
Query roads with `surface` tag:

```
[out:json][timeout:25];
way({bbox})["highway"]["surface"];
out body;
>;
out skel qt;
```
Returns all roads with a surface tag. The rule flags segments where `surface` is in the excluded list (gravel, unpaved, dirt, etc.).

#### R11: Road Classification
Query roads with `highway` tag:

```
[out:json][timeout:25];
way({bbox})["highway"];
out body;
>;
out skel qt;
```
Returns all roads with a highway tag. The rule flags segments on excluded highway types (motorway, trunk) without bike accommodation.

#### R12: Traffic Volume Proxy
Same query as R11 (highway tag), plus check for `bicycle`/`cycleway` tags:

```
[out:json][timeout:25];
way({bbox})["highway"]["bicycle"];
way({bbox})["highway"]["cycleway"];
way({bbox})["highway"]["cycleway:left"];
way({bbox})["highway"]["cycleway:right"];
out body;
>;
out skel qt;
```
Returns roads that have explicit bike accommodation. The rule flags high-traffic highways (motorway, trunk, primary) that are NOT in this result set.

#### R14: Dead End
Query roads and their node connections:

```
[out:json][timeout:25];
way({bbox})["highway"]->.roads;
(
  node(w.roads);
);
out body;
```
Returns all nodes connected to roads in the area. The rule checks if the route's endpoint road connects to a node with degree 1 (no other roads connected) — a dead end.

#### R16: Tunnel Flag
Query roads with `tunnel` tag:

```
[out:json][timeout:25];
way({bbox})["tunnel"];
out body;
>;
out skel qt;
```
Returns all roads with a tunnel tag. The rule measures how many consecutive trackpoints fall within each tunnel segment and flags if total tunnel length exceeds the threshold.

#### R19: Bike-Banned Roads
Query roads with `bicycle=no` or `bicycle=denied`:

```
[out:json][timeout:25];
way({bbox})["highway"]["bicycle"="no"];
way({bbox})["highway"]["bicycle"="denied"];
out body;
>;
out skel qt;
```
Returns all roads where cycling is explicitly prohibited. The rule flags any trackpoint whose matched road segment is in this set.

#### R20: Speed Limit Proxy
Query roads with both `maxspeed` and `highway` tags:

```
[out:json][timeout:25];
way({bbox})["maxspeed"]["highway"];
way({bbox})["maxspeed"]["highway"]["bicycle"];
way({bbox})["maxspeed"]["highway"]["cycleway"];
out body;
>;
out skel qt;
```
Returns roads with speed limits, with and without bike accommodation. The rule flags segments where `maxspeed` exceeds the threshold AND no bike tag exists.

#### R17: Bridge Height Clearance (low-signal, v3)
Query bridges with `layer` or `height` tags:

```
[out:json][timeout:25];
way({bbox})["bridge"]["layer"];
way({bbox})["bridge"]["height"];
out body;
>;
out skel qt;
```
Returns bridges with layer/height metadata. Rarely available in OSM, so low signal. Included for completeness.

#### Combined Query (Optimized)
For routes that trigger multiple OSM-dependent rules, use a single combined query to minimize API calls:

```
[out:json][timeout:30];
(
  // All roads with any tag we care about
  way({bbox})["highway"]["surface"];
  way({bbox})["highway"]["oneway"];
  way({bbox})["highway"]["oneway"]["bicycle"];
  way({bbox})["highway"]["oneway"]["cycleway"];
  way({bbox})["highway"]["bicycle"="no"];
  way({bbox})["highway"]["bicycle"="denied"];
  way({bbox})["highway"]["maxspeed"];
  way({bbox})["highway"]["tunnel"];
  way({bbox})["highway"]["cycleway"];
  way({bbox})["highway"]["cycleway:left"];
  way({bbox})["highway"]["cycleway:right"];
  way({bbox})["bridge"]["layer"];
  way({bbox})["bridge"]["height"];
);
out body;
>;
out skel qt;
```
This returns ALL relevant OSM data in one call. The rule engine then distributes the data to each rule that needs it.

**Caching strategy:** Cache Overpass results keyed by `(bbox, query_hash)`. TTL: 7 days (road network changes slowly; road works are handled separately via user GeoJSON).

**Rate limiting:** Public instances allow ~1 request/second. For large routes, batch Overpass queries the same way as routing API calls (50-point batches).

### 2c. Data availability and failure policy (locked)

Availability is tracked independently for each required stage and data source. A failed or partial data source must never be interpreted as evidence that a route passes a rule.

```ts
type AvailabilityStatus =
  | 'not_required'
  | 'complete'
  | 'partial'
  | 'unavailable'

interface DataSourceAvailability {
  status: AvailabilityStatus
  source: string
  requestedItems: number
  availableItems: number
  message?: string
}

interface DataAvailability {
  gpx: DataSourceAvailability
  roadMatching: DataSourceAvailability
  osm: DataSourceAvailability
  roadworks: DataSourceAvailability
  incomplete: boolean
}
```

**Status meanings:**
- `not_required`: no enabled rule or requested operation needs this source.
- `complete`: all requested data was obtained and validated.
- `partial`: some requested data is available, but one or more points, segments, or features could not be resolved.
- `unavailable`: no usable data was obtained for a required source.

`incomplete` is true if any source required by an enabled rule is `partial` or `unavailable`. Optional data for disabled rules does not make a run incomplete. The report records the source status, requested/available counts, and a diagnostic message; it does not hide the reason for incomplete data.

Availability is measured against the inputs required by enabled rules, not merely whether an HTTP response arrived. A successful OSM response can still be `partial` for a rule if required tags or road matches are missing for part of the route. A missing OSM tag is never treated as a negative finding or a pass; it makes that rule's affected scope `unknown`. Sources not involved in the rule (for example, road matching for a GPX-only rule) do not affect that rule's outcome.

**Request and fallback policy:**
- Use a 10-second request timeout for routing-provider requests and the Overpass query timeout already specified in each query (25 seconds, or 30 seconds for the combined query).
- Retry transient timeouts, HTTP 429, and HTTP 5xx responses once. Honor a valid `Retry-After` header up to 5 seconds; if absent, wait 1 second before retrying. If the header requests a longer delay, do not retry. Do not retry other 4xx responses or invalid requests.
- Try the configured fallback routing provider after the primary provider exhausts its retry, but only if the fallback is configured. Record which provider supplied each result.
- A response that is malformed or cannot be matched to requested coordinates is unusable and is treated as a provider failure; never substitute an empty successful result.
- Do not cache failed, malformed, or partial responses as complete results. Cached data must retain its provider and fetch timestamp.
- Use cached responses only within their configured TTL (30 days for road resolution, 7 days for Overpass). Expired cache entries do not count as available data and are not silently substituted when a live request fails.
- A valid partial response may be used for the items it covers; uncovered items remain unavailable. Do not infer that uncovered roads or tags are absent.

**Rule behavior when data is incomplete:**
- Evaluate rules independently wherever their required inputs are available. For example, a routing or Overpass outage does not prevent GPX-only rules from running.
- For each affected location or segment without sufficient input, emit `unknown` with the missing source and reason. Do not emit `pass` for an unevaluated area.
- A rule may report `pass` for the covered portion and `unknown` for uncovered portions; the report's per-rule aggregate must remain `unknown` unless the rule's full applicable scope was evaluated.
- If a source is unavailable for the entire rule, emit one rule-level `unknown` result rather than fabricating per-point failures.
- Incomplete data is distinct from validation failure. Keep both states visible if a run has known violations and unevaluated areas.

**CLI exit codes:**
- `0`: run completed with sufficient data and no `error`-severity failures.
- `1`: run completed with sufficient data and at least one `error`-severity failure.
- `2`: run is incomplete because a required source was partial or unavailable, regardless of any known rule failures.
- `3`: fatal input, configuration, or runtime error prevented a report from being produced.

When both validation errors and incomplete data exist, return `2`; the report still includes the known validation errors. Warnings and `info` failures do not change the exit code. There is no separate strict-mode switch: incomplete required data is non-zero by default so automation cannot mistake an unevaluated route for a clean one.

### 3. Rule Engine
Rules are loaded from a YAML config file. Each rule has:
- `id`: unique name (e.g., `contraflow-bike`)
- `enabled`: boolean (default `true`)
- `severity`: `error`, `warning`, `info`
- `description`: what it checks
- `params`: rule-specific parameters

Rules run against resolved road segments and return a structured result model instead of a raw boolean. A rule may emit zero or many result objects, including `pass`, `fail`, `unknown`, and `skipped` outcomes.

#### Rule outcome model (locked)
The rule evaluation contract is intentionally richer than a pass/fail boolean because real route checks need to distinguish compliance from incomplete or unreliable data.

```ts
interface RuleResult {
  ruleId: string
  status: 'pass' | 'fail' | 'unknown' | 'skipped'
  severity: 'error' | 'warning' | 'info'
  confidence: 'high' | 'medium' | 'low'
  message: string
  lat?: number
  lon?: number
  evidence?: Record<string, unknown>
  source?: Record<string, unknown>
}
```

**Status semantics:**
- `pass`: rule evaluated successfully and the condition is compliant
- `fail`: rule evaluated successfully and the condition is violated
- `unknown`: evaluation could not be completed reliably because data was missing, the map match was ambiguous, or an API failed
- `skipped`: rule was disabled, not applicable, or explicitly ignored via route context

**Severity vs status:**
- `severity` describes user-facing importance (`error` / `warning` / `info`)
- `status` describes evaluation outcome (`pass` / `fail` / `unknown` / `skipped`)
- These are not interchangeable. A rule can be `fail` with `warning` severity, or `unknown` with `error` severity if the data is incomplete enough that the route cannot be trusted.

**Example:**
```json
{
  "ruleId": "contraflow-bike",
  "status": "unknown",
  "severity": "error",
  "confidence": "low",
  "message": "Could not evaluate contraflow because nearby parallel streets created an ambiguous road match",
  "lat": 48.8566,
  "lon": 2.3522,
  "source": { "provider": "graphhopper", "tagSet": ["oneway", "bicycle"] }
}
```

**Rule execution contract:**
- A rule must not silently convert `unknown` into `pass`.
- A rule must not emit a positive result without a reason and source/evidence when it depends on OSM or map matching.
- Rule implementations must be deterministic for a given route + config + data availability state.

### 4. Output
- Summary: counts by severity and by result status (`pass`, `fail`, `unknown`, `skipped`)
- Per-rule breakdown: count of failures, unknowns, and skipped results
- Detailed report: list of rule results with lat/lng, message, severity, status, confidence, and source metadata
- Exit code: use the data availability and failure policy above

---

## Built-in Rules

### R1: Maximum Slope
- **Category:** Physical Exertion
- **Description:** Flag any segment where the gradient exceeds a configurable threshold.
- **Config:** `max_percent: 10` (default 10)
- **How:** For consecutive trackpoints, compute `delta_elevation / horizontal_distance * 100`. Skip if either point lacks elevation.
- **Severity:** `error` (configurable)
- **Data needed:** Elevation in GPX (or filled from OpenElevation in v2)
- **Complexity:** Low
- **Output:** lat/lng of the failing segment start, the slope value, the threshold.

### R2: Contraflow Bike Lane Violation
- **Category:** Safety
- **Description:** Flag segments where the route goes against a `oneway=yes` road that lacks a `bicycle` contraflow exception (e.g., `bicycle=designated`, `cycleway=opposite`).
- **How:** After road resolution, check OSM tags on the matched road segment. If `oneway=yes` AND no bike exception → flag as error. If `oneway=yes` AND `bicycle` tag indicates contraflow is allowed → no flag.
- **Severity:** `error`
- **Data needed:** OSM `oneway` + `bicycle`/`cycleway` tags
- **Complexity:** Low
- **Output:** lat/lng, road name, the conflicting tags.

### R3: Road Works Overlap
- **Category:** Infrastructure
- **Description:** Flag trackpoints that fall within a GeoJSON polygon/line of active road works.
- **Config:** `geojson_file: "path/to/roadworks.geojson"` (relative or absolute)
- **How:** Load the GeoJSON, buffer each feature by N meters (configurable, default 5m), then check which trackpoints fall within any buffered feature.
- **Severity:** `warning` (configurable)
- **Data needed:** User-provided GeoJSON
- **Complexity:** Low
- **Output:** lat/lng, name/description from GeoJSON properties, distance to works zone.

---

### R4: Sharp Turn / U-Turn
- **Category:** Safety
- **Description:** Flag consecutive trackpoints with a bearing change exceeding a threshold. A sharp turn often means a wrong turn, a dangerous intersection, or an unnecessary U-turn.
- **Config:** `max_angle: 60` (degrees)
- **How:** Compute bearing between point N-1 → N and N → N+1. Flag if the angle difference exceeds `max_angle`. Needs ≥3 consecutive points.
- **Severity:** `warning`
- **Data needed:** ≥3 consecutive trackpoints (no elevation required)
- **Complexity:** Low
- **Output:** lat/lng of the turning point, the bearing change angle, the threshold.

### R5: Off-Road Distance
- **Category:** Safety
- **Description:** Flag trackpoints that are more than N meters from any mapped road. Catches segments going through fields, forests, or unauthorized paths.
- **Config:** `max_distance_meters: 50` (default 50)
- **How:** After road resolution, check distance from each point to its matched road segment. Flag if > `max_distance_meters`.
- **Severity:** `error` (configurable to `warning`)
- **Data needed:** Road resolution (OSRM/GraphHopper)
- **Complexity:** Low
- **Output:** lat/lng, distance to nearest road, road name.

### R6: Missing Elevation
- **Category:** Data Quality
- **Description:** Flag GPX files where more than X% of trackpoints lack elevation data. Without elevation, slope checks are impossible and total elevation gain is unknown.
- **Config:** `max_missing_percent: 20` (default 20)
- **How:** Count trackpoints without `ele` tag. Flag if percentage exceeds threshold.
- **Severity:** `info`
- **Data needed:** None (pure GPX parsing)
- **Complexity:** None
- **Output:** Percentage of points missing elevation, total point count.

### R7: Long Climb Warning
- **Category:** Physical Exertion
- **Description:** Flag sustained climbs above a gradient threshold lasting longer than a distance or time threshold. Short steep sections are fine; a 2km climb at 12% might be the dealbreaker.
- **Config:** `gradient_threshold: 8`, `min_distance_meters: 500`
- **How:** Accumulate consecutive segments above `gradient_threshold`. Flag when cumulative distance exceeds `min_distance_meters`.
- **Severity:** `warning`
- **Data needed:** Elevation in GPX (or filled from OpenElevation in v2)
- **Complexity:** Medium
- **Output:** Start/end lat/lng of the climb, total distance, average gradient, elevation gain.

### R8: Total Elevation Gain Budget
- **Category:** Physical Exertion
- **Description:** Flag routes exceeding a maximum total elevation gain.
- **Config:** `max_elevation_gain_meters: 1500`
- **How:** Simple accumulation of all positive elevation changes between consecutive trackpoints.
- **Severity:** `warning`
- **Data needed:** Elevation in GPX (or filled from OpenElevation in v2)
- **Complexity:** Low
- **Output:** Total elevation gain, the threshold, the percentage of the budget used.

### R9: Descent Warning
- **Category:** Physical Exertion
- **Description:** Flag extreme descents that may be risky on road bikes (narrow tires, no suspension). Mirror of R7 but for descents.
- **Config:** `max_descent_percent: -12`, `min_distance_meters: 300`
- **How:** Accumulate consecutive segments below the threshold (negative gradient). Flag when cumulative distance exceeds `min_distance_meters`.
- **Severity:** `warning`
- **Data needed:** Elevation in GPX (or filled from OpenElevation in v2)
- **Complexity:** Medium
- **Output:** Start/end lat/lng of the descent, total distance, average gradient, elevation loss.

### R10: Surface Type
- **Category:** Infrastructure Quality
- **Description:** Flag segments on unpaved, gravel, or footpath surfaces.
- **Config:** `allowed_surfaces: ["paved", "asphalt", "concrete", "chipseal", "cobblestone"]` (default paved types)
- **How:** After road resolution, check OSM `surface` tag. Flag if value is `unpaved`, `gravel`, `dirt`, `ground`, `grass`, `mud`, `pebblestone`, `earth`.
- **Severity:** `error` (configurable to `warning`)
- **Data needed:** OSM `surface` tag
- **Complexity:** Low
- **Output:** lat/lng, road name, the surface tag value.

### R11: Road Classification
- **Category:** Infrastructure Quality
- **Description:** Flag segments on roads not suitable for bikes (motorways, trunk roads without bike lanes).
- **Config:** `allowed_highways: ["residential", "tertiary", "secondary", "primary", "motorway", "trunk", "cycleway", "path", "footway"]` (default: all — no restriction)
- **How:** After road resolution, check OSM `highway` tag. Flag if the highway type is not in the allowed list (or is motorway/trunk without `bicycle=yes`).
- **Severity:** `error` (configurable to `warning`)
- **Data needed:** OSM `highway` + `bicycle` tags
- **Complexity:** Low
- **Output:** lat/lng, road name, the highway tag value.

### R12: Traffic Volume Proxy
- **Category:** Infrastructure Quality
- **Description:** Flag segments on high-traffic road types (motorways, trunk, primary) that lack any bike accommodation. Not actual traffic data (OSM doesn't carry that) — uses road class + bike tag as proxy.
- **Config:** `check_highways: ["motorway", "trunk", "primary"]`, `require_bike_lane: true`
- **How:** After road resolution, if `highway` is in `check_highways` AND no `bicycle`/`cycleway` tag indicates bike accommodation → flag.
- **Severity:** `warning`
- **Data needed:** OSM `highway` + `bicycle`/`cycleway` tags
- **Complexity:** Low
- **Output:** lat/lng, road name, the highway type, missing bike accommodation.

### R13: Route Continuity / Gaps
- **Category:** Route Topology
- **Description:** Flag large jumps between consecutive trackpoints (>N meters) that suggest a missing segment (e.g., ferry ride, train carry, or GPS drop).
- **Config:** `max_gap_meters: 500`
- **How:** Simple distance check between consecutive points. Flag if > `max_gap_meters`.
- **Severity:** `info`
- **Data needed:** None (pure GPX parsing)
- **Complexity:** None
- **Output:** lat/lng of the gap start and end, the gap distance, the threshold.

### R14: Dead End / Cul-de-sac
- **Category:** Route Topology
- **Description:** Flag routes that terminate on a road segment with no continuing path (a dead end or cul-de-sac).
- **Config:** `check_endpoints: true`, `lookahead_points: 10`
- **How:** Check the last N trackpoints. If the final road segment connects to an OSM node with degree 1 (no continuing road), flag it.
- **Severity:** `warning`
- **Data needed:** Road resolution (OSRM/GraphHopper) + OSM node degree
- **Complexity:** Medium
- **Output:** lat/lng of the dead end, road name, road type.

### R15: Loop Closure
- **Category:** Route Topology
- **Description:** For loop rides, flag routes that don't return close to the start point.
- **Config:** `max_return_distance_meters: 100`
- **How:** Compute distance between first and last trackpoint. Flag if > `max_return_distance_meters`.
- **Severity:** `info`
- **Data needed:** None (pure GPX parsing)
- **Complexity:** None
- **Output:** Start lat/lng, end lat/lng, the distance between them, the threshold.

### R16: Tunnel Flag
- **Category:** Environmental / Comfort
- **Description:** Flag segments passing through tunnels (`tunnel=yes` or `tunnel=building_passage`). Tunnels on bikes can mean poor air quality, no lighting, or being banned.
- **Config:** `max_tunnel_length_meters: 200` (flag tunnels longer than this)
- **How:** After road resolution, check OSM `tunnel` tag. Measure tunnel segment length from consecutive points within the tunnel. Flag if length exceeds threshold.
- **Severity:** `warning`
- **Data needed:** OSM `tunnel` tag
- **Complexity:** Low
- **Output:** lat/lng of tunnel start/end, tunnel name (if any), tunnel length, tunnel type.

### R17: Bridge Height Clearance
- **Category:** Environmental / Comfort
- **Description:** Flag bridges with low vertical clearance. Low clearance underpasses can be tight squeezes.
- **Config:** `min_clearance_meters: 3.0`
- **How:** After road resolution, check OSM `layer` or `height`/`width` tags on bridge segments. Flag if clearance < `min_clearance_meters`.
- **Severity:** `info`
- **Data needed:** OSM bridge/height tags (low signal — rarely available in OSM)
- **Complexity:** Low (but low data availability)
- **Output:** lat/lng, bridge name (if any), the clearance value.

### R18: Shade / Tree Cover
- **Category:** Environmental / Comfort
- **Description:** Flag segments with no or minimal tree canopy cover (useful in summer). Requires a separate tree canopy GeoJSON or satellite-derived canopy layer.
- **Config:** `min_canopy_percent: 30` (flag segments below this canopy coverage)
- **How:** Load a separate GeoJSON layer (e.g., from NLCD or ESA WorldCover tree canopy). For each trackpoint, check canopy coverage at that location. Flag if below `min_canopy_percent`.
- **Severity:** `info`
- **Data needed:** External tree canopy GeoJSON or satellite layer
- **Complexity:** High (requires external data source and management)
- **Output:** lat/lng, canopy coverage percentage, the threshold.

### R19: Bike-Banned Roads
- **Category:** Legal / Regulatory
- **Description:** Flag segments where bicycles are explicitly prohibited (`bicycle=no` or `bicycle=denied`).
- **Config:** `check_all_segments: true`
- **How:** After road resolution, check OSM `bicycle` tag. Flag if value is `no` or `denied`.
- **Severity:** `error`
- **Data needed:** OSM `bicycle` tag
- **Complexity:** Low
- **Output:** lat/lng, road name, the `bicycle` tag value.

### R20: Speed Limit Proxy
- **Description:** Flag segments with high speed limits (>60 km/h or >40 mph) that lack bike infrastructure.
- **Config:** `max_speed_kmh: 60`, `require_bike_lane: true`
- **How:** After road resolution, check OSM `maxspeed` tag. Flag if speed exceeds threshold AND no `bicycle`/`cycleway` tag indicates bike accommodation.
- **Severity:** `warning`
- **Data needed:** OSM `maxspeed` + `bicycle`/`cycleway` tags
- **Complexity:** Low
- **Output:** lat/lng, road name, the speed limit, missing bike accommodation.

---

## Rules Summary Table

| # | Rule | Category | Severity | Data Needed | Complexity |
|---|------|----------|----------|-------------|------------|
| R1 | Maximum Slope | Physical Exertion | error | Elevation in GPX | Low | v1 |
| R2 | Contraflow Bike Violation | Safety | error | OSM oneway + bicycle | Low | v1 |
| R3 | Road Works Overlap | Infrastructure | warning | User GeoJSON | Low | v1 |
| R4 | Sharp Turn / U-Turn | Safety | warning | 3+ consecutive points | Low | v1 |
| R5 | Off-Road Distance | Safety | error | Road resolution | Low | v1 |
| R6 | Missing Elevation | Data Quality | info | None (GPX parsing) | None | v1 |
| R7 | Long Climb Warning | Physical Exertion | warning | Elevation | Medium | v2 |
| R8 | Total Elevation Gain | Physical Exertion | warning | Elevation | Low | v2 |
| R9 | Descent Warning | Physical Exertion | warning | Elevation | Medium | v2 |
| R10 | Surface Type | Infrastructure Quality | error | OSM surface tag | Low | v2 |
| R11 | Road Classification | Infrastructure Quality | error | OSM highway tag | Low | v2 |
| R12 | Traffic Volume Proxy | Infrastructure Quality | warning | OSM highway + bike | Low | v2 |
| R13 | Route Gaps | Route Topology | info | None (GPX parsing) | None | v1 |
| R14 | Dead End | Route Topology | warning | Road resolution | Medium | v2 |
| R15 | Loop Closure | Route Topology | info | None (GPX parsing) | None | v1 |
| R16 | Tunnel Flag | Environmental | warning | OSM tunnel tag | Low | v2 |
| R17 | Bridge Height Clearance | Environmental | info | OSM bridge/height | Low (low signal) | v3 |
| R18 | Shade / Tree Cover | Environmental | info | External canopy layer | High | v3 |
| R19 | Bike-Banned Roads | Legal / Regulatory | error | OSM bicycle tag | Low | v2 |
| R20 | Speed Limit Proxy | Legal / Regulatory | warning | OSM maxspeed + bike | Low | v2 |

**Complexity key:** None = pure GPX parsing (no external data). Low = needs road resolution. Medium = needs road resolution + elevation or OSM node degree. High = needs external data source.

---

## Config File Format (example)

```yaml
# gpxlint.yml
rules:
  max_slope:
    enabled: true
    severity: error
    params:
      max_percent: 10

  contraflow_bike:
    enabled: true
    severity: error

  roadworks:
    enabled: true
    severity: warning
    params:
      geojson_file: "./data/roadworks.geojson"
      buffer_meters: 5

  sharp_turn:
    enabled: true
    severity: warning
    params:
      max_angle: 60

  off_road:
    enabled: false  # disabled by default
    severity: error
    params:
      max_distance_meters: 50

  surface_type:
    enabled: true
    severity: error
    params:
      allowed_surfaces: ["paved", "asphalt", "concrete", "chipseal"]

  bike_banned:
    enabled: true
    severity: error

routing:
  provider: osrm        # osrm | graphhopper | offline
  url: "http://localhost:5000"
  batch_size: 50        # points per API call

reporting:
  format: text          # text | json | html
  color: auto           # auto | always | never
```

---

## CLI Interface (proposed)

```bash
# Core check
gpxlint check route.gpx
gpxlint check route.gpx --config gpxlint.yml

# Per-rule control
gpxlint check route.gpx --rule max_slope --disable
gpxlint check route.gpx --rule surface_type --enable

# Inline overrides
gpxlint check route.gpx --geojson roadworks.geojson
gpxlint check route.gpx --routing osrm --url http://osrm.local

# Rule management
gpxlint rules list          # show all rules with status
gpxlint rules enable contraflow_bike
gpxlint rules disable roadworks

# Output formats
gpxlint check route.gpx --format json
gpxlint check route.gpx --format html --output report.html
```

---

## Extensibility — First-Class Design

Extensibility is not an afterthought — it's a core design principle. Anyone should be able to create a rule in under 5 minutes, with zero TypeScript knowledge if they want. Three layers of increasing power:

### Layer 1: Declarative YAML Rules (No Code)

The simplest way to create a rule. Define it in your `gpxlint.yml` — no Python, no restart, no install.

```yaml
rules:
  my_custom_rule:
    enabled: true
    severity: warning
    description: "Flag segments on cobblestone streets"
    params:
      allowed_surfaces: ["asphalt", "concrete", "chipseal"]
      excluded_surfaces: ["cobblestone", "paving_stones", "bricks"]
    # Built-in rule template reference
    template: surface_filter
```

The `template` field maps to a built-in rule template. The user only needs to specify which surfaces to allow/exclude. Under the hood, the engine loads the `surface_filter` template and applies the user's params.

**Built-in templates (ship with gpxlint):**

| Template | What it does | User params |
|----------|-------------|-------------|
| `slope_max` | Flag segments above X% gradient | `max_percent` |
| `slope_long_climb` | Flag sustained climbs | `gradient_threshold`, `min_distance_meters` |
| `slope_descent` | Flag sustained descents | `gradient_threshold`, `min_distance_meters` |
| `surface_filter` | Flag segments with excluded surface types | `excluded_surfaces`, `allowed_surfaces` |
| `offroad_distance` | Flag points >N meters from road | `max_distance_meters` |
| `contraflow` | Flag one-way without bike exception | (none) |
| `roadworks_buffer` | Flag points within buffer of GeoJSON | `geojson_file`, `buffer_meters` |
| `sharp_turn` | Flag bearing changes >X degrees | `max_angle` |
| `gap_max` | Flag jumps >X meters between points | `max_gap_meters` |
| `loop_closure` | Flag non-looping routes | `max_return_distance_meters` |
| `highway_filter` | Flag segments on excluded road types | `excluded_highways`, `allowed_highways` |
| `highway_traffic` | Flag high-traffic roads without bike lanes | `check_highways` |
| `bike_banned` | Flag segments where cycling is prohibited | (none) |
| `speed_limit` | Flag high-speed roads without bike infrastructure | `max_speed_kmh` |
| `tunnel_length` | Flag tunnels longer than X meters | `max_tunnel_length_meters` |
| `missing_elevation` | Flag files with >X% missing elevation | `max_missing_percent` |
| `elevation_budget` | Flag total elevation gain >X meters | `max_elevation_gain_meters` |
| `dead_end` | Flag routes ending at dead ends | (none) |

**How it works:**
1. User writes a YAML rule with `template: <name>`.
2. Engine resolves the template, injects user params.
3. Template runs with the user's values. Done.

No TypeScript, no install, no restart. Just edit the YAML and re-run.

### Layer 2: Rule Templates Library (Community-Shared)

A registry of community-contributed rule templates. Think of it as "npm for GPX rules."

```bash
# List available templates
gpxlint templates list

# Search for a template
gpxlint templates search "surface"

# Install a template from the registry
gpxlint templates install gpxlint-community/bridge-height
gpxlint templates install https://github.com/user/gpxlint-bridge-rule

# Use it in config
rules:
  my_bridge_check:
    template: bridge-height
    params:
      min_clearance_meters: 4.0
```

Templates are standalone YAML files that define:
- The rule logic (TypeScript code, bundled and hidden)
- Default params
- Description and documentation
- Tags for discoverability (e.g., `["safety", "infrastructure"]`)

The registry is a simple GitHub repo (or any git host). Templates are `.gpxlint` files:

```yaml
# .gpxlint (a rule template)
name: bridge-height
version: 1.0.0
description: Flag bridges with low vertical clearance
tags: [safety, environmental]
severity: info
params:
  min_clearance_meters: 3.0
code_file: bridge_height.ts
```

Users can contribute templates by submitting PRs to the community registry or hosting their own.

### Layer 3: TypeScript Plugins (Full Power)

For rules that templates can't express (e.g., cross-referencing multiple data sources, complex geometry).

```typescript
// ~/.gpxlint/rules/my_rule.ts
import { Rule, Violation, Trackpoint, ResolvedSegment, Metadata }
  from 'gpxlint'

export class MyRule implements Rule {
  name = 'my-rule'
  severity = 'warning' as const
  description = 'Flag routes that pass within 10m of a school zone'

  evaluate(
    trackpoints: Trackpoint[],
    resolvedSegments: ResolvedSegment[],
    metadata: Metadata
  ): Violation[] {
    const violations: Violation[] = []
    for (let i = 0; i < trackpoints.length; i++) {
      const segment = resolvedSegments[i]
      if (segment.osmTags?.amenity === 'school') {
        const schoolZone = this.getSchoolZone(segment)
        if (trackpoints[i].distanceTo(schoolZone) < 10) {
          violations.push(new Violation({
            lat: trackpoints[i].lat,
            lon: trackpoints[i].lon,
            message: 'Route passes within 10m of school zone',
            severity: this.severity,
            context: { schoolName: segment.name }
          }))
        }
      }
    }
    return violations
  }
}
```

**Plugin discovery:**
- Files in `~/.gpxlint/rules/` are auto-discovered on startup.
- Packages installed via `npm install gpxlint-my-rule` are auto-discovered.
- Files in the current directory under `./rules/` are discovered when `--rules-dir` is passed.

**Plugin API — what's available:**

```typescript
interface Rule {
  name: string
  severity: 'error' | 'warning' | 'info'
  description: string
  paramsSchema?: Record<string, unknown>  // JSON Schema for param validation

  evaluate(
    trackpoints: Trackpoint[],
    resolvedSegments: ResolvedSegment[],
    metadata: Metadata
  ): Violation[]
}
```

**Trackpoint interface:**
```typescript
interface Trackpoint {
  lat: number
  lon: number
  ele: number | null       // Elevation (meters, from GPX or filled)
  time: Date | null        // Timestamp (from GPX)
  distanceFromStart: number  // Cumulative distance (meters)
  bearing: number | null     // Bearing to next point (degrees)
  index: number              // Position in track
  distanceTo(other: Trackpoint): number  // Haversine distance
}
```

**ResolvedSegment interface:**
```typescript
interface ResolvedSegment {
  roadId: string             // OSM way ID
  name: string | null        // Road name
  highway: string | null     // highway tag (residential, primary, etc.)
  surface: string | null     // surface tag (asphalt, gravel, etc.)
  oneway: string | null      // oneway tag (yes, no, -1, etc.)
  bicycle: string | null     // bicycle tag (designated, yes, no, etc.)
  maxspeed: string | null    // maxspeed tag (50, 30 mph, etc.)
  tunnel: string | null      // tunnel tag (yes, building_passage, etc.)
  bridge: string | null      // bridge tag (yes, viaduct, etc.)
  cycleway: string | null    // cycleway tag (opposite, no, etc.)
  distanceToRoad: number     // How far the point is from the road (meters)
  osmTags: Record<string, string>  // All other OSM tags as a dict
}
```

**Metadata interface:**
```typescript
interface Metadata {
  gpxName: string | null      // <name> tag in GPX
  gpxCreator: string | null   // <text> creator tag
  trackDate: Date | null      // Earliest timestamp in track
  totalPoints: number
  totalDistance: number       // Total route distance (meters)
  totalElevationGain: number  // Total elevation gain (meters)
}
```

**Violation interface:**
```typescript
interface Violation {
  lat: number
  lon: number
  message: string
  severity: 'error' | 'warning' | 'info'
  confidence?: 'high' | 'medium' | 'low' | 'unknown'
  source?: Record<string, unknown>
  context: Record<string, unknown>  // Arbitrary metadata for reports
}
```

**Data availability / completeness interface:**
```typescript
// See "Data availability and failure policy" for the canonical contract.
type DataAvailability = {
  gpx: DataSourceAvailability
  roadMatching: DataSourceAvailability
  osm: DataSourceAvailability
  roadworks: DataSourceAvailability
  incomplete: boolean
}
```

### Layer 4: Rule Registry (Optional, v2)

A centralized registry for sharing community rules. Could be:
- A GitHub repository (simplest)
- A web-based registry (gpxlint.com/registry)
- Local registry file (`~/.gpxlint/registry.json`)

```bash
# Search the registry
gpxlint registry search "school zone"

# Install a registry rule
gpxlint registry install gpxlint-community/school-zone

# Publish your own (if registry supports it)
gpxlint registry publish my-rule.gpxlint
```

---

### CLI for Rule Management

```bash
# Create a new rule (interactive wizard)
gpxlint rule create
  # Prompts: name, description, severity, template or "blank"
  # If blank: opens template TypeScript file
  # If template: fills in params

# List all rules (built-in + user-created)
gpxlint rules list
  # Shows: name | severity | type (template/plugin/builtin) | enabled

# Get help on a specific rule
gpxlint rules show max_slope

# Test a rule on a sample GPX
gpxlint rules test my_rule --file sample.gpx

# Export a rule as a shareable template
gpxlint rules export my_rule > ~/my_rule.gpxlint
```

---

### Offline Mode
- Pre-download a street network (OSM PBF) + use `valhalla` or `project-osrm` locally.
- No network dependency for routing.

### Elevation Fill (v2)
- Optional fill missing elevation from OpenElevation/SRTM API.
- Config: `fill_elevation: true`

### Date-Based Road Works Filtering (v2)
- GeoJSON road works with `start_date`/`end_date` properties.
- Only flag works active on the date of the GPX track.

---

## File Structure (proposed)

```
gpxlint/
├── package.json
├── tsconfig.json
├── gpxlint/
│   ├── src/
│   │   ├── index.ts          # Core exports (Rule, Violation, Trackpoint, etc.)
│   │   ├── cli.ts            # Commander CLI
│   │   ├── gpxParser.ts      # GPX → trackpoints
│   │   ├── resolver.ts       # Trackpoints → road segments (GraphHopper/OSRM)
│   │   ├── rules/
│   │   │   ├── base.ts       # Rule interface (Rule abstract class)
│   │   │   ├── maxSlope.ts   # R1
│   │   │   ├── contraflow.ts # R2
│   │   │   ├── roadworks.ts  # R3
│   │   │   ├── sharpTurn.ts  # R4
│   │   │   ├── offRoad.ts    # R5
│   │   │   ├── missingElev.ts# R6
│   │   │   ├── longClimb.ts  # R7
│   │   │   ├── totalElev.ts  # R8
│   │   │   ├── descent.ts    # R9
│   │   │   ├── surface.ts    # R10
│   │   │   ├── roadClass.ts  # R11
│   │   │   ├── traffic.ts    # R12
│   │   │   ├── gaps.ts       # R13
│   │   │   ├── deadEnd.ts    # R14
│   │   │   ├── loop.ts       # R15
│   │   │   ├── tunnel.ts     # R16
│   │   │   ├── bridgeHeight.ts# R17
│   │   │   ├── shade.ts      # R18
│   │   │   ├── bikeBanned.ts # R19
│   │   │   └── speedLimit.ts # R20
│   │   ├── config.ts         # YAML config loading
│   │   └── reporter.ts       # Text/JSON/HTML output
│   └── templates/            # Built-in rule templates (compiled TS)
├── tests/
│   ├── gpxParser.test.ts
│   ├── maxSlope.test.ts
│   ├── contraflow.test.ts
│   ├── roadworks.test.ts
│   ├── sharpTurn.test.ts
│   ├── offRoad.test.ts
│   └── ... (test for each rule)
└── examples/
    ├── sample.gpx
    └── gpxlint.yml
```

---

## Open Questions — Resolved

### 1. Routing API: GraphHopper (primary) + OSRM (fallback)

**Decision: GraphHopper as primary, OSRM as fallback.**

- **GraphHopper** has a dedicated bike routing profile that understands bike-specific constraints (cycleways, steps, ferries, elevation-aware routing). It returns richer metadata per segment (surface, highway, bicycle, oneway, maxspeed) than OSRM.
- **OSRM** is faster and lighter, but its default profile is car-oriented. The bike profile exists but is less mature.
- **Overpass API** doesn't do routing — it just queries OSM tags. Can be used as a supplementary tool for specific tag lookups, but not as the primary resolution engine.

**Config:**
```yaml
routing:
  primary: graphhopper
  fallback: osrm
  graphhopper_url: "http://localhost:8989"
  osrm_url: "http://localhost:5000"
```

**Fallback strategy:** If GraphHopper is unreachable, try OSRM. Accept that OSRM returns less metadata (surface, traffic proxy may have lower signal).

### 2. Elevation Source

**Decision: Skip fill in v1. Flag missing elevation as `info` (R6). v2: optional fill from OpenElevation API.**

- R6 already flags files with >X% missing elevation — this tells the user "your GPX is thin" without making assumptions.
- Filling elevation from an API introduces a new network dependency, latency, and potential inaccuracies (SRTM is 30m resolution, 90m in some areas).
- Many GPX files from modern GPS watches (Garmin, Wahoo) include accurate barometric or GPS-derived elevation. No fill needed.
- v2: Add `fill_elevation: true` config option that calls the OpenElevation API (free, self-hostable) to fill gaps.

### 3. GeoJSON Road Works Format

**Decision: Minimal required properties — geometry only. Optional: `name`, `start_date`, `end_date`, `type`, `description`.**

The GeoJSON should follow this schema:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[...]]
      },
      "properties": {
        "name": "Road construction — Rue de Rivoli",
        "type": "construction",
        "description": "Lane closure, expect detour",
        "start_date": "2025-09-01",
        "end_date": "2026-02-28"
      }
    }
  ]
}
```

- **Required:** Only the geometry (Point, LineString, or Polygon).
- **Recommended:** `name` — shown in reports.
- **Optional (v2 date filtering):** `start_date` and `end_date` (ISO 8601). If present, only flag works that overlap the GPX track date. If absent, always flag.
- **Optional:** `type` — categorization (construction, accident, event, protest). Useful for filtering.

**Default buffer:** 5 meters (configurable). For polygons, buffer inward/outward. For LineStrings, buffer as a zone around the line.

### 4. Batch Size for Routing API

**Decision: Default 50 points per batch, configurable.**

- GraphHopper `table` endpoint accepts up to 100 points per request. OSRM `table` accepts up to 300.
- 50 is a safe middle ground that works for both providers without hitting limits.
- Large GPX files (2000+ points) will make ~40 API calls. At ~200ms per call, that's ~8 seconds — acceptable.
- Configurable via `routing.batch_size` in the YAML config.

```yaml
routing:
  batch_size: 50  # points per API call (1-100 for GraphHopper, 1-300 for OSRM)
```

### 5. Caching

**Decision: Disk-based cache keyed by (lat, lon) → (road_id, osm_tags). Store in `~/.cache/gpxlint/`. TTL: 30 days.**

- Cache the entire resolution result for a given lat,lon pair. Key: SHA-256 of `"lat,lon"`.
- Store: `{road_id, osm_tags, road_name, oneway, bicycle, surface, highway, maxspeed, tunnel, bridge, distance_to_road}`
- TTL: 30 days (road network doesn't change that often; road works are handled separately via GeoJSON).
- Cache is per-machine, not shared.
- Cache can be cleared with `gpxlint cache clear`.

```
~/.cache/gpxlint/
├── cache.db          # SQLite: key → {road_id, tags, timestamp}
└── geojson/          # User-provided GeoJSON files (cached copies)
```

**Cache behavior:**
1. On `check`, resolve all points.
2. For each point, check cache first.
3. If cached and < 30 days old, use it.
4. If not cached or expired, call API, store result.
5. Report cache hit/miss stats.

### 6. Which Rules Ship as v1?

**Decision: 8 rules for v1 — the ones that deliver core value with minimal dependencies.**

**v1 rules (ship with initial release):**

| Rule | Why v1? |
|------|---------|
| R1 Max Slope | Core value — what the user asked for. Needs only GPX elevation. |
| R2 Contraflow | Core value — what the user asked for. Needs road resolution (one API call). |
| R3 Road Works | Core value — what the user asked for. User-provided GeoJSON, no API needed. |
| R4 Sharp Turn | High signal, no external data. Catches obvious route errors. |
| R5 Off-Road | High signal for road-only riders. Needs road resolution (one API call). |
| R6 Missing Elevation | Zero cost, tells user "your GPX might be unreliable". |
| R13 Route Gaps | Zero cost, catches ferry/train/missing segments. |
| R15 Loop Closure | Zero cost, useful for loop validation. |

**v2 rules (add after v1 ships):**

| Rule | Why v2? |
|------|---------|
| R7 Long Climb | Medium complexity, needs elevation + road resolution. |
| R8 Total Elevation Gain | Low complexity, but needs elevation (v2 fill). |
| R9 Descent Warning | Medium complexity, needs elevation. |
| R10 Surface Type | Needs road resolution + rich metadata (GraphHopper). |
| R11 Road Classification | Needs road resolution. |
| R12 Traffic Proxy | Needs road resolution + bike tag. |
| R14 Dead End | Medium complexity, needs OSM node degree. |
| R16 Tunnel Flag | Low complexity, needs tunnel tag from resolution. |
| R19 Bike-Banned Roads | High signal, needs bicycle tag from resolution. |
| R20 Speed Limit | Low signal but useful, needs maxspeed + bike tag. |

**v3 (nice-to-have, not priority):**

| Rule | Why v3? |
|------|---------|
| R17 Bridge Height | Low signal — rarely in OSM. |
| R18 Shade / Tree Cover | Requires external data layer (NLCD/ESA). High complexity. |

---

## Critical Issues to Fix Before Implementation

The spec is strong as a product concept, but several assumptions must be resolved before engineering work begins. These are the blockers that most affect correctness, trust, and real-world usability.

### 1. Map-matching and confidence are first-class requirements

The spec must not assume that every GPX point can be snapped to a road segment with sufficient accuracy. In real data, nearest-road matching is often wrong near parallel streets, cycle lanes, service roads, underpasses, overpasses, and sidewalks.

**Decision:**
- Map-matching is a separate pipeline stage with a `MatchResult` object.
- Each point is assigned a `status` (`matched | ambiguous | unmatched`) and a `confidence` (`high | medium | low | unknown`).
- The system keeps a candidate set when there are multiple plausible roads instead of forcing a single match.
- Safety-critical and OSM-dependent rules require a minimum confidence threshold before evaluation.

**Required rules:**
- Use a weighted candidate score based on distance to road, heading continuity, topology continuity, and bike-specific plausibility.
- Treat `ambiguous` and `unknown` as distinct from `pass` and `fail`.
- For rules like R2, R5, R10, R11, R12, R19, and R20, only evaluate when confidence is at least `medium`.
- For low-confidence matches, emit a `data_quality` issue instead of a route violation.

### 2. OSM tags are imperfect data, not ground truth

The spec must treat OSM metadata as a probabilistic input layer, not as a perfect source of truth.

**Decision:**
- Every tag should carry metadata about source and confidence where available.
- Missing tags must behave as `unknown`, not as `pass`.
- A tag value must be interpreted with explicit handling for absence, stale data, and regional conventions.

**Required behavior:**
- Add a metadata layer for each tag: `value`, `source`, `confidence`, `last_updated`, `coverage`.
- Example: `surface: { value: "gravel", source: "osm", confidence: "medium" }`.
- If a tag is absent, the rule should return `unknown` instead of `pass`.
- For safety-critical rules, require a higher confidence threshold before flagging an error.
- Missing or ambiguous tag data produces `unknown`; it is not configurable into a pass.

### 3. Rule outcomes must support uncertainty

Several rules are currently phrased as binary checks, but real systems need a richer result model.

**Decision:**
- Every rule returns `pass | fail | unknown | skipped`.
- `unknown` is explicitly used for missing data, failed enrichment, or low-confidence matching.

**Required output contract:**
```ts
interface RuleResult {
  status: 'pass' | 'fail' | 'unknown' | 'skipped'
  confidence: 'high' | 'medium' | 'low'
  reason?: string
  evidence?: Record<string, unknown>
}
```

- `unknown` results are surfaced separately in reports, rather than being folded into pass/fail totals.
- CLI output distinguishes between rule failures and uncertain results.

### 4. Network and API failure modes are part of the design

The spec includes GraphHopper, OSRM, and Overpass, but not the failure modes.

**Decision:** Apply the locked data availability and failure policy in Section 2c. Rules continue on available inputs, emit `unknown` for uncovered scope, and never infer a pass from a failed source. Required-source incompleteness has a distinct non-zero exit code by default.

### 5. Elevation and slope logic must account for GPS jitter and noise

R1, R7, R8, and R9 rely on elevation differences, but raw GPX data can be noisy or inconsistent.

**Decision:**
- Elevation must be smoothed before grade calculations.
- Minimum segment length and minimum elevation delta thresholds must be enforced.
- Short noisy spikes cannot trigger slope violations.

**Required behavior:**
- Apply a small moving average or median filter to elevation before computing gradients.
- Ignore calculations for short segments under a minimum distance threshold.
- Require both a minimum gradient magnitude and a minimum segment length before a slope violation is reported.
- Use the same smoothing strategy across all elevation-based rules.

### 6. Rule definitions need stronger edge-case handling

Several rules are operationally ambiguous and will generate noisy results without explicit edge-case rules.

**Examples:**
- R4: GPS jitter can create false sharp turns.
- R13: ferries and train segments can legitimately create large gaps.
- R15: loop closures may naturally not return exactly to the start.
- R14: dead ends may be valid routing decisions, not necessarily errors.

**Decision:**
- Define a minimum segment length or minimum heading change before a sharp turn is considered a violation.
- Allow users to classify route-level exceptions, such as `ferry_allowed: true` or `ignore_dead_end: true`.
- Add a route context object: `route_type`, `loop_expected`, `terrain`, `bike_type`, `expected_access`.
- For each rule, define whether it is “route validity” or “route quality.”

### 7. Validation must be dataset-driven from the start

The current success criteria list is a useful start, but it is not enough to prove rule quality.

**Decision:**
- Build a real corpus of GPX routes with known outcomes before broad rollout.
- Include urban, rural, mountain, mixed-surface, and ambiguous cases.
- Add negative tests for missing OSM data and bad matches.

**Required fixtures:**
- valid bike routes
- steep but legal climbs
- contraflow one-way roads
- missing elevation GPX
- road works overlapping the path
- ambiguous road snapping cases
- routes with missing or stale OSM tags
- route segments with ferries, train tracks, or intentionally dead-end roads

Measure rule precision/recall before expanding the rule set.

### 8. The v1 scope should be narrowed to what is genuinely trustworthy

The current v1 architecture is broad enough to hide major reliability problems.

**Recommended v1 tightening:**
- Keep: R1, R3, R4, R6, R13, R15
- Add only when road matching confidence is high: R2, R5
- Defer R10–R20 until the matching and OSM metadata pipeline is proven reliable

This protects the initial release from creating a tool that looks powerful but produces noisy or misleading results.

### 9. Explainability and human review are mandatory

Users will not trust the system unless the report explains why it flagged something.

**Decision:**
- Every violation must include:
  - rule name
  - route segment or point
  - matched road ID or nearest road
  - confidence score
  - source data used
  - human-readable explanation

**Example:**

```json
{
  "rule": "contraflow-bike",
  "status": "fail",
  "confidence": "medium",
  "lat": 48.8566,
  "lon": 2.3522,
  "reason": "Road matched to oneway=yes with no bicycle contraflow tag",
  "source": { "provider": "graphhopper", "tagSet": ["oneway", "bicycle"] }
}
```

This is not optional; it is what makes the output auditable.

---

## Recommended Implementation Order

1. Define a data model for route resolution confidence and rule outcomes.
2. Implement GPX parsing and raw geometry checks (slope, gaps, turns, loop closure) without relying on external data.
3. Build map-matching with confidence scoring and unknown handling.
4. Add OSM enrichment with tag metadata and fallback rules.
5. Add safety-critical rules only after match confidence has been validated.
6. Add GeoJSON road works and reporting.
7. Add advanced rules incrementally with fixture validation.

This sequencing reduces false positives and keeps the first version credible.

---

## Success Criteria (v1)

- [ ] Parses valid GPX files (multiple tracks/segments)
- [ ] Resolves trackpoints to road segments via GraphHopper (with OSRM fallback)
- [ ] R1 (max slope) correctly flags segments above threshold
- [ ] R2 (contraflow) correctly flags one-way violations without bike exception
- [ ] R3 (roadworks) correctly flags points within buffered GeoJSON zones
- [ ] R4 (sharp turn) correctly flags turns exceeding angle threshold
- [ ] R5 (off-road) correctly flags points >N meters from roads
- [ ] R6 (missing elevation) correctly reports % of points without elevation
- [ ] R13 (gaps) correctly flags large point-to-point jumps
- [ ] R15 (loop closure) correctly flags non-looping routes
- [ ] Configurable rules via YAML (enable/disable/change severity)
- [ ] Reports per-source availability and emits `unknown` rather than `pass` for unevaluated rule scope
- [ ] Applies bounded retries, provider fallback, and cache TTLs as defined by the failure policy
- [ ] Returns the documented exit codes for clean runs, validation errors, incomplete data, and fatal errors
- [ ] CLI help text and `rules list` command
- [ ] Disk-based caching (30-day TTL, `~/.cache/gpxlint/`)
- [ ] Cache stats shown in output (hits, misses)
- [ ] All tests pass (unit + integration with mock GraphHopper/OSRM, vitest)
