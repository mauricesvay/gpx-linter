---
finding_id: 1
category: must_fix
severity: high
component: src/cli.ts, src/linter.ts, src/config.ts
status: open
tags:
  - cli
  - bug
  - geojson
  - roadworks
---

# GeoJSON CLI Flag Silently Ignored

## What this is

The CLI accepts `--geojson roadworks.geojson` but `runLinter` never reads it. The config loader resolves `geojson_file` relative to the YAML config file, but the CLI flag is silently discarded.

## Problem

Users running `npx gpxlint check route.gpx --geojson data/roadworks.geojson` will get "no valid GeoJSON data" even though they specified a file. The roadworks rule is enabled but receives no data.

## Fix

Pass the CLI `--geojson` path into `runLinter` options and resolve it relative to CWD (or the config dir if config is present), then set it on the rule definition's `params.geojson_file`.

## If we skip it

Users who rely on the CLI flag get silent failures — roadworks rules report "unavailable" and the user has no clear indication that their flag was ignored.
