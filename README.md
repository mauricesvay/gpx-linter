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
| `route_gaps` | disabled | GPX geometry |
| `loop_closure` | disabled | GPX geometry |
| `bike_lane_no_same_direction_car_lane` | disabled | Road match and OSM way geometry/tags |

For `bike_lane_no_same_direction_car_lane`, a nearby road only counts when its
local geometry aligns with the route; a crossing road does not count, and a
one-way road must also permit travel in the route's direction.

Unavailable or ambiguous inputs produce `unknown`, not a pass. Reports show source availability separately; the check exits with code `2` if required data is incomplete, `1` for complete runs with error-severity findings, `0` for complete runs without errors, and `3` for fatal input/config/runtime errors. Warning and info findings do not affect the validation exit code.

## Configuration

Pass a YAML file using `--config`. Settings merge with the built-in defaults. See [`examples/gpxlint.yml`](examples/gpxlint.yml) for a full example.

The roadworks GeoJSON source is configured in the YAML file using the `geojson_file` parameter under the `roadworks` rule. Config-relative paths resolve relative to the YAML file. GeoJSON roadworks support `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, and `MultiPolygon` features. `properties.name` is included in findings when available.

## CLI

```text
npx gpxlint check route.gpx [--config gpxlint.yml]
  [--dry-run]
  [--max-points <n>]
  [--rule max_slope --disable|--enable]
  [--routing overpass|offline] [--pbf path/to/osm.pbf] [--url URL]
  [--format text|json|html] [--output report.json] [--no-cache]

npx gpxlint rules list
npx gpxlint cache clear
```

`--routing offline` requires `--pbf <path>` pointing to an OSM PBF extract
(e.g. from [Geofabrik](https://download.geofabrik.de/)). The linter parses
the PBF locally, extracts highway ways within the route's bounding box, and
snaps trackpoints to those ways — zero network calls. Without a PBF file,
`--routing offline` reports all road-dependent rules as unknown.

## Matching, data, and privacy

Road matching fetches OSM highway geometry from Overpass and snaps trackpoints to nearby ways locally, retaining confidence, snap distance, and unmatched/ambiguous states. Contraflow evaluation reuses the same Overpass data (way tags like `oneway`, `bus_lane`) and compares the route's direction with the OSM way direction. Public Overpass mirrors are used by default; configure `overpass_url` for a self-hosted instance. Route coordinates are sent to the Overpass endpoint you configure.

When using `--routing offline --pbf <file>`, all data comes from the local PBF file — no network access is needed. The PBF is parsed at runtime, highway ways are extracted within the route's bounding box, and trackpoints are snapped to those ways entirely offline.

Successful road matches are cached for 30 days and complete Overpass responses for 7 days under `~/.cache/gpxlint/`. Expired entries are ignored. Failed and partial responses are not cached as complete data. Cache hit and miss counts appear in the report. PBF data is not cached — it is parsed on every invocation from the file you specify.

## Report formats

- `text` (default): terminal-friendly summary, source availability, and findings
- `json`: full structured report for automation
- `html`: standalone report page

Each result carries status, severity, confidence, message, route location where applicable, evidence, and data source metadata.
