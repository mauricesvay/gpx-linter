# GPX Route Linter

`gpxlint` checks cycling GPX tracks for route-quality and safety issues. It parses multiple tracks and segments, runs deterministic local checks, and uses confidence-aware road matching plus OSM data only for rules that need them.

## Requirements

- Node.js 20 or newer
- npm

## Install and run

```sh
npm install
npm run build
node dist/cli.js --help
node dist/cli.js check route.gpx
```

The built-in CLI is also exposed as `gpxlint` when the package is installed. To run the automated suite and compile TypeScript:

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
| `sharp_turn` | enabled | GPX geometry |
| `off_road` | disabled | Road match |
| `missing_elevation` | enabled | GPX elevation fields |
| `route_gaps` | enabled | GPX geometry |
| `loop_closure` | enabled, skipped unless `loop_expected` is true | GPX geometry |

Unavailable or ambiguous inputs produce `unknown`, not a pass. Reports show source availability separately; the check exits with code `2` if required data is incomplete, `1` for complete runs with error-severity findings, `0` for complete runs without errors, and `3` for fatal input/config/runtime errors. Warning and info findings do not affect the validation exit code.

## Configuration

Pass a YAML file using `--config`. Settings merge with the built-in defaults:

```yaml
rules:
  max_slope:
    enabled: true
    severity: error
    params:
      max_percent: 10
      min_segment_meters: 3
      min_elevation_delta_meters: 1.5

  contraflow_bike:
    enabled: true
    severity: error

  roadworks:
    enabled: true
    severity: warning
    params:
      geojson_file: ./data/roadworks.geojson
      buffer_meters: 5

  sharp_turn:
    enabled: true
    severity: warning
    params:
      max_angle: 60
      min_segment_meters: 5

  off_road:
    enabled: false
    severity: error
    params:
      max_distance_meters: 50

route_context:
  loop_expected: false
  ferry_allowed: false

routing:
  provider: osrm
  fallback: graphhopper
  osrm_url: https://router.project-osrm.org
  graphhopper_url: http://localhost:8989
  batch_size: 50
  cache: true

reporting:
  format: text
```

The roadworks source can also be supplied inline:

```sh
gpxlint check route.gpx --geojson data/roadworks.geojson
```

Config-relative GeoJSON paths resolve relative to the YAML file. GeoJSON roadworks support `Point`, `MultiPoint`, `LineString`, `MultiLineString`, `Polygon`, and `MultiPolygon` features. `properties.name` is included in findings when available.

## CLI

```text
gpxlint check route.gpx [--config gpxlint.yml]
  [--rule max_slope --disable|--enable]
  [--geojson roadworks.geojson]
  [--routing osrm|graphhopper|offline] [--url URL]
  [--format text|json|html] [--output report.json] [--no-cache]

gpxlint rules list
gpxlint cache clear
```

`--routing offline` currently means no live routing backend: road-dependent rules will be reported as unknown unless a future offline backend is configured. It does not silently substitute a nearest-road guess.

## Matching, data, and privacy

Road matching uses OSRM map matching (with optional GraphHopper fallback) and retains confidence, snap distance, and unmatched/ambiguous states. Contraflow evaluation additionally requests road geometry and tags from Overpass and compares the route's direction with the OSM way direction. The public OSRM and Overpass endpoints are used by default; configure local service URLs for private or offline environments. Route coordinates are sent to whichever configured services are used.

Successful road matches are cached for 30 days and complete Overpass responses for 7 days under `~/.cache/gpxlint/`. Expired entries are ignored. Failed and partial responses are not cached as complete data. Cache hit and miss counts appear in the report.

## Report formats

- `text` (default): terminal-friendly summary, source availability, and findings
- `json`: full structured report for automation
- `html`: standalone report page

Each result carries status, severity, confidence, message, route location where applicable, evidence, and data source metadata.
