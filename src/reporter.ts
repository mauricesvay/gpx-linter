import type {
	CacheStats,
	DataAvailability,
	LintReport,
	RuleResult,
	TrackCoordinate,
} from "./types";

export function createReport(input: {
	routeName: string;
	results: RuleResult[];
	availability: DataAvailability;
	cache: CacheStats;
	trackCoords?: TrackCoordinate[];
}): LintReport {
	const availability: DataAvailability = {
		...input.availability,
		incomplete:
			input.availability.incomplete ||
			input.results.some((result) => result.status === "unknown"),
	};
	const summary = {
		severity: { error: 0, warning: 0, info: 0 },
		status: { pass: 0, fail: 0, unknown: 0, skipped: 0 },
	};
	const rules: LintReport["rules"] = {};
	for (const item of input.results) {
		summary.status[item.status]++;
		if (item.status === "fail") summary.severity[item.severity]++;
		const rule = rules[item.ruleId] ?? { failures: 0, unknown: 0, skipped: 0 };
		if (item.status === "fail") rule.failures++;
		if (item.status === "unknown") rule.unknown++;
		if (item.status === "skipped") rule.skipped++;
		rules[item.ruleId] = rule;
	}
	const exitCode = availability.incomplete
		? 2
		: summary.severity.error > 0
			? 1
			: 0;
	return {
		routeName: input.routeName,
		generatedAt: new Date().toISOString(),
		summary,
		rules,
		results: input.results,
		availability,
		cache: input.cache,
		exitCode,
		trackCoords: input.trackCoords,
	};
}

export function formatReport(
	report: LintReport,
	format: "text" | "json" | "html" = "text",
	color: "auto" | "always" | "never" = "auto",
): string {
	if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
	if (format === "html") return formatHtml(report);
	return formatText(report, color);
}

function formatText(
	report: LintReport,
	color: "auto" | "always" | "never",
): string {
	const useColor =
		color === "always" || (color === "auto" && Boolean(process.stdout.isTTY));
	const paint = (value: string, code: number): string =>
		useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
	const lines = [
		`GPX route report: ${report.routeName}`,
		`Result: ${report.summary.severity.error} error(s), ${report.summary.severity.warning} warning(s), ${report.summary.severity.info} info failure(s)`,
		`Outcomes: ${report.summary.status.pass} pass, ${report.summary.status.fail} fail, ${report.summary.status.unknown} unknown, ${report.summary.status.skipped} skipped`,
		`Cache: ${report.cache.hits} hit(s), ${report.cache.misses} miss(es)`,
		`Data complete: ${report.availability.incomplete ? "no" : "yes"}`,
	];
	for (const [source, availability] of Object.entries(report.availability)) {
		if (source === "incomplete") continue;
		lines.push(
			`  ${source}: ${availability.status} (${availability.availableItems}/${availability.requestedItems})${availability.message ? ` — ${availability.message}` : ""}`,
		);
	}
	if (report.results.length > 0) {
		lines.push("", "Findings:");
		for (const item of report.results) {
			const position =
				item.lat === undefined || item.lon === undefined
					? ""
					: ` [${item.lat.toFixed(6)}, ${item.lon.toFixed(6)}]`;
			const source = item.source
				? ` (${Object.entries(item.source)
						.map(([key, value]) => `${key}=${String(value)}`)
						.join(", ")})`
				: "";
			const statusCode =
				item.status === "fail"
					? 31
					: item.status === "unknown"
						? 33
						: item.status === "pass"
							? 32
							: 90;
			const severityCode =
				item.severity === "error" ? 31 : item.severity === "warning" ? 33 : 36;
			lines.push(
				`  ${paint(item.status.toUpperCase(), statusCode)} ${paint(item.severity.toUpperCase(), severityCode)} ${item.ruleId}${position}: ${item.message}${source}`,
			);
		}
	}
	lines.push(`Exit code: ${report.exitCode}`);
	return `${lines.join("\n")}\n`;
}

function formatHtml(report: LintReport): string {
	const findings = report.results
		.map(
			(item) =>
				`<li class="${escapeHtml(item.status)}"><strong>${escapeHtml(item.status.toUpperCase())} ${escapeHtml(item.severity.toUpperCase())} ${escapeHtml(item.ruleId)}</strong>: ${escapeHtml(item.message)}${item.lat === undefined ? "" : ` <span>(${item.lat.toFixed(6)}, ${item.lon?.toFixed(6)})</span>`}</li>`,
		)
		.join("\n");
	const statuses = Object.entries(report.availability)
		.filter(([key]) => key !== "incomplete")
		.map(
			([key, item]) =>
				`<li>${escapeHtml(key)}: ${escapeHtml(item.status)} (${item.availableItems}/${item.requestedItems})${item.message ? ` — ${escapeHtml(item.message)}` : ""}</li>`,
		)
		.join("\n");
	const trackCoords = report.trackCoords || [];
	const findingsWithCoords = report.results.filter(
		(r) => r.lat !== undefined && r.lon !== undefined,
	);

	if (trackCoords.length === 0 || findingsWithCoords.length === 0) {
		return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GPX report — ${escapeHtml(report.routeName)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#202124}li{margin:.55rem 0}.fail{color:#a12020}.unknown{color:#765900}.pass{color:#176b37}.skipped{color:#555}</style></head>
<body><h1>GPX route report: ${escapeHtml(report.routeName)}</h1>
<p>${report.summary.severity.error} error(s), ${report.summary.severity.warning} warning(s), ${report.summary.severity.info} info failure(s)</p>
<h2>Data availability</h2><ul>${statuses}</ul>
<h2>Findings</h2><ul>${findings}</ul><p>Exit code: ${report.exitCode}</p></body></html>
`;
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

	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GPX report — ${escapeHtml(report.routeName)}</title>
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
<body><h1>GPX route report: ${escapeHtml(report.routeName)}</h1>
<p>${report.summary.severity.error} error(s), ${report.summary.severity.warning} warning(s), ${report.summary.severity.info} info failure(s)</p>
<h2>Map</h2>
<div id="map"></div>
<p class="map-info">Route: ${trackCoords.length} points | Findings: ${findingsWithCoords.length} markers</p>
<h2>Data availability</h2><ul>${statuses}</ul>
<h2>Findings</h2><ul>${findings}</ul><p>Exit code: ${report.exitCode}</p>
<script>
(function() {
  var track = ${trackJson};
  var findings = ${findingsJson};
  var map = L.map('map').setView([track[0][0], track[0][1]], 13);
  var tileUrl = 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png';
  L.tileLayer(tileUrl, {
    maxZoom: 19,
    attribution: '\u00A9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  var trackPolyline = L.polyline(track, {color: '#2667d9', weight: 4}).addTo(map);
  map.fitBounds(trackPolyline.getBounds().pad(0.1));
  var severityColor = {error: '#d32f2f', warning: '#f57c00', info: '#1976d2'};
  var statusIcon = {pass: '\u2714', fail: '\u2717', unknown: '?', skipped: '\u2014'};
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
}

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
