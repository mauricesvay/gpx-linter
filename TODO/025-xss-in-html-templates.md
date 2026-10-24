---
finding_id: 25
category: should_fix
severity: medium
component: src/htmlTemplate.ts, src/templates/
status: open
tags:
  - security
  - xss
  - html
---

# OSM Data Embedded in HTML Reports May Not Be Fully Sanitized

## What this is

HTML reports embed OSM data (way names, properties) directly into the HTML via Handlebars templates and JSON-in-script blocks.

## Problem

While `escapeHtml` is used for some fields, OSM property values (e.g., `description`, `name`) from GeoJSON features are embedded in JSON via `JSON.stringify` with a regex replace for `</script>`. However, OSM tags containing HTML-like content (e.g., `<east>`) could potentially break out of script contexts or cause rendering issues.

## Fix

Audit all Handlebars template usage and JSON-in-script embedding. Ensure all user-supplied OSM data is properly escaped for its context (HTML attribute, script string, JSON).

## If we skip it

A malicious OSM tag (e.g., `name="</script><script>alert(1)</script>"`) could potentially break out of the embedded JSON block in edge cases, though the `</script>` replacement mitigates the most obvious vector.
