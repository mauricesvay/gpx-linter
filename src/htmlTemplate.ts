import type { LintReport, RuleResult, TrackCoordinate } from "./types";

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character]!,
	);
}

function buildFindingsHtml(results: RuleResult[]): string {
	return results
		.map(
			(item) =>
				`<li class="${escapeHtml(item.status)}"><strong>${escapeHtml(item.status.toUpperCase())} ${escapeHtml(item.severity.toUpperCase())} ${escapeHtml(item.ruleId)}</strong>: ${escapeHtml(item.message)}${item.lat === undefined ? "" : ` <span>(${item.lat.toFixed(6)}, ${item.lon?.toFixed(6)})</span>`}</li>`,
		)
		.join("\n");
}

function buildStatusesHtml(availability: LintReport["availability"]): string {
	return Object.entries(availability)
		.filter(([key]) => key !== "incomplete")
		.map(
			([key, item]) =>
				`<li>${escapeHtml(key)}: ${escapeHtml(item.status)} (${item.availableItems}/${item.requestedItems})${item.message ? ` — ${escapeHtml(item.message)}` : ""}</li>`,
		)
		.join("\n");
}

const SIMPLE_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GPX report — {{routeName}}</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#202124}li{margin:.55rem 0}.fail{color:#a12020}.unknown{color:#765900}.pass{color:#176b37}.skipped{color:#555}</style></head>
<body><h1>GPX route report: {{routeName}}</h1>
<p>{{errorCount}} error(s), {{warningCount}} warning(s), {{infoCount}} info failure(s)</p>
<h2>Data availability</h2><ul>{{statuses}}</ul>
<h2>Findings</h2><ul>{{findings}}</ul><p>Exit code: {{exitCode}}</p></body></html>
`;

const MAP_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GPX report — {{routeName}}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script src="https://unpkg.com/pmtiles@3.0.7/dist/pmtiles.js"></script>
<style>
body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#202124}
li{margin:.55rem 0}
.fail{color:#a12020}
.unknown{color:#765900}
.pass{color:#176b37}
.skipped{color:#555}
#map{height:500px;width:100%;border-radius:8px;margin:1rem 0}
.map-info{font-size:13px;color:#555;margin:.5rem 0}
</style></head>
<body><h1>GPX route report: {{routeName}}</h1>
<p>{{errorCount}} error(s), {{warningCount}} warning(s), {{infoCount}} info failure(s)</p>
<h2>Map</h2>
<div id="map"></div>
<p class="map-info">Route: {{pointCount}} points | Findings: {{markerCount}} markers</p>
<h2>Data availability</h2><ul>{{statuses}}</ul>
<h2>Findings</h2><ul>{{findings}}</ul><p>Exit code: {{exitCode}}</p>
<script>
(function() {
  var track = {{trackJson}};
  var findings = {{findingsJson}};
  var map = L.map('map').setView([track[0][0], track[0][1]], 13);
  var tileUrl = 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png';
  L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '\\u00A9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var trackPolyline = L.polyline(track, {color: '#2667d9', weight: 4}).addTo(map);
  map.fitBounds(trackPolyline.getBounds().pad(0.1));
  var severityColor = {error: '#d32f2f', warning: '#f57c00', info: '#1976d2'};
  var statusIcon = {pass: '\\u2714', fail: '\\u2717', unknown: '?', skipped: '\\u2014'};
  findings.forEach(function(f) {
    var color = severityColor[f.severity] || '#555';
    var marker = L.circleMarker([f.lat, f.lon], {
      radius: 8,
      fillColor: color,
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.8
    }).addTo(map);
    var label = statusIcon[f.status] || '';
    marker.bindPopup('<strong>' + f.ruleId + '</strong><br>' + f.message + '<br><em>' + f.status.toUpperCase() + '</em>');
  });
})();
</script>
</body></html>
`;

function substitute(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
		vars[key] ?? `{{${key}}}`,
	);
}

export function formatHtml(report: LintReport): string {
	const findings = buildFindingsHtml(report.results);
	const statuses = buildStatusesHtml(report.availability);
	const trackCoords = report.trackCoords || [];
	const findingsWithCoords = report.results.filter(
		(r) => r.lat !== undefined && r.lon !== undefined,
	);

	const baseVars: Record<string, string> = {
		routeName: escapeHtml(report.routeName),
		errorCount: String(report.summary.severity.error),
		warningCount: String(report.summary.severity.warning),
		infoCount: String(report.summary.severity.info),
		exitCode: String(report.exitCode),
		statuses,
		findings,
	};

	if (trackCoords.length === 0 || findingsWithCoords.length === 0) {
		return substitute(SIMPLE_HTML_TEMPLATE, {
			...baseVars,
		});
	}

	const trackJson = JSON.stringify(trackCoords.map((c) => [c.lat, c.lon]));
	const findingsJson = JSON.stringify(
		findingsWithCoords.map((f) => ({
			lat: f.lat!,
			lon: f.lon!,
			ruleId: f.ruleId,
			status: f.status,
			severity: f.severity,
			message: f.message,
		})),
	);

	return substitute(MAP_HTML_TEMPLATE, {
		...baseVars,
		pointCount: String(trackCoords.length),
		markerCount: String(findingsWithCoords.length),
		trackJson,
		findingsJson,
	});
}
