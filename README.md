# GPX Route Linter

`gpxlint` checks cycling GPX tracks for route-quality and safety issues. It parses multiple tracks and segments, runs deterministic local checks, and uses confidence-aware road matching plus OSM data only for rules that need them.

## Requirements

- Node.js 20 or newer
- npm

## Install and run

```sh
npm install
npm run build
npx gpxlint --help
npx gpxlint check examples/test.gpx --config examples/gpxlint.yml --format html --output report.html
```
To run the automated suite and compile TypeScript:

```sh
npm run check
```

## Rules

The v1 implementation includes:

| Rule ID | Default | Required input |
| --- | --- | --- |
| `max_slope` | enabled | GPX elevation |
| `contraflow_bike` | enabled | Road match and OSM road tags |
| `roadworks` | disabled | GeoJSON file |
| `sharp_turn` | disabled | GPX geometry |
| `off_road` | disabled | Road match |
| `missing_elevation` | enabled | GPX elevation fields |
| `route_gaps` | enabled | GPX geometry |
| `loop_closure` | enabled, skipped unless `loop_expected` is true | GPX geometry |
| `bike_lane_no_same_direction_car_lane` | enabled | Road match and OSM way geometry/tags |

For `bike_lane_no_same_direction_car_lane`, a nearby road only counts when its
local geometry aligns with the route; a crossing road does not count, and a
one-way road must also permit travel in the route's direction.

Unavailable or ambiguous inputs produce `unknown`, not a pass. Reports show source availability separately; the check exits with code `2` if required data is incomplete, `1` for complete runs with error-severity findings, `0` for complete runs without errors, and `3` for fatal input/config/runtime errors. Warning and info findings do not affect the validation exit code.

## Configuration

Pass a YAML file using `--config`. Settings merge with the built-in defaults. See [`examples/gpxlint.yml`](examples/gpxlint.yml) for a full example.

The roadworks source can also be supplied inline:

```sh
npx gpxlint check route.gpx --geojson data/roadworks.geojson
```

Config-relative GeoJSON paths resolve relative to the YAML file. GeoJSON roadworks support `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, and `MultiPolygon` features. `properties.name` is included in findings when available.

## CLI

```text
npx gpxlint check route.gpx [--config gpxlint.yml]
  [--rule max_slope --disable|--enable]
  [--geojson roadworks.geojson]
  [--routing overpass|offline] [--url URL]
  [--format text|json|html] [--output report.json] [--no-cache]

npx gpxlint rules list
npx gpxlint cache clear
```

`--routing offline` currently means no live routing backend: road-dependent rules will be reported as unknown unless a future offline backend is configured. It does not silently substitute a nearest-road guess.

## Matching, data, and privacy

Road matching fetches OSM highway geometry from Overpass and snaps trackpoints to nearby ways locally, retaining confidence, snap distance, and unmatched/ambiguous states. Contraflow evaluation reuses the same Overpass data (way tags like `oneway`, `bus_lane`) and compares the route's direction with the OSM way direction. Public Overpass mirrors are used by default; configure `overpass_url` for a self-hosted instance. Route coordinates are sent to the Overpass endpoint you configure.

Successful road matches are cached for 30 days and complete Overpass responses for 7 days under `~/.cache/gpxlint/`. Expired entries are ignored. Failed and partial responses are not cached as complete data. Cache hit and miss counts appear in the report.

## Report formats

- `text` (default): terminal-friendly summary, source availability, and findings
- `json`: full structured report for automation
- `html`: standalone report page

Each result carries status, severity, confidence, message, route location where applicable, evidence, and data source metadata.
