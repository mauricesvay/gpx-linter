import type {
	CacheStats,
	DataAvailability,
	LintReport,
	RouteMetadata,
	RuleResult,
	TrackCoordinate,
} from "./types";
import { formatHtml as formatHtmlOutput } from "./htmlTemplate";

interface ResultRange {
	ruleId: string;
	status: RuleResult["status"];
	severity: RuleResult["severity"];
	confidence: RuleResult["confidence"];
	message: string;
	source?: Record<string, unknown>;
	startIndex: number;
	endIndex: number;
	startLat?: number;
	startLon?: number;
	endLat?: number;
	endLon?: number;
	distanceFromStart?: number;
	distanceToEnd?: number;
	evidence?: Record<string, unknown>;
}

/** Group contiguous results by ruleId and segment into ranges. */
function groupContiguousResults(results: RuleResult[]): ResultRange[] {
	// Filter to only results with a pointIndex
	const indexed = results
		.filter((r) => r.pointIndex !== undefined)
		.sort((a, b) => (a.pointIndex ?? 0) - (b.pointIndex ?? 0));

	if (indexed.length === 0) return [];

	const ranges: ResultRange[] = [];
	let current: ResultRange | null = null;

	for (const r of indexed) {
		const idx = r.pointIndex!;
		const segmentId = (r as unknown as { segmentId?: number }).segmentId;

		if (
			!current ||
			current.status !== r.status ||
			current.severity !== r.severity ||
			current.ruleId !== r.ruleId ||
			current.endIndex !== idx - 1
		) {
			// Start a new range
			if (current) ranges.push(current);
			current = {
				ruleId: r.ruleId,
				status: r.status,
				severity: r.severity,
				confidence: r.confidence,
				message: r.message,
				source: r.source,
				evidence: r.evidence,
				startIndex: idx,
				endIndex: idx,
				startLat: r.lat,
				startLon: r.lon,
				endLat: r.lat,
				endLon: r.lon,
			};
		} else {
			// Extend the range
			current.endIndex = idx;
			current.endLat = r.lat;
			current.endLon = r.lon;
		}
	}
	if (current) ranges.push(current);
	return ranges;
}

export function createReport(input: {
	routeName: string;
	results: RuleResult[];
	availability: DataAvailability;
	cache: CacheStats;
	trackCoords?: TrackCoordinate[];
	matchedRoadIds?: (string | null)[];
	matchedHighway?: (string | null)[];
	matchedStatus?: (string | null)[];
	routeStats?: Pick<RouteMetadata, "totalDistance" | "totalElevationGain" | "maxGradient">;
	enabledRules?: Set<string>;
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
	const enabledRules = input.enabledRules ?? new Set<string>();
	for (const item of input.results) {
		summary.status[item.status]++;
		if (item.status === "fail") summary.severity[item.severity]++;
		const rule = rules[item.ruleId] ?? { failures: 0, unknown: 0, skipped: 0, enabled: false };
		if (item.status === "fail") rule.failures++;
		if (item.status === "unknown") rule.unknown++;
		if (item.status === "skipped") rule.skipped++;
		rule.enabled = enabledRules.has(item.ruleId);
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
		matchedRoadIds: input.matchedRoadIds,
		matchedHighway: input.matchedHighway,
		matchedStatus: input.matchedStatus,
		routeStats: input.routeStats ?? {
			totalDistance: 0,
			totalElevationGain: 0,
			maxGradient: 0,
		},
	};
}

export async function formatReport(
	report: LintReport,
	format: "text" | "json" | "html" = "text",
	color: "auto" | "always" | "never" = "auto",
): Promise<string> {
	if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
	if (format === "html") return formatHtmlOutput(report);
	return formatText(report, color);
}

function km(distanceMeters: number): string {
	return (distanceMeters / 1000).toFixed(2);
}

function formatText(
	report: LintReport,
	color: "auto" | "always" | "never",
): string {
	const useColor =
		color === "always" || (color === "auto" && Boolean(process.stdout.isTTY));
	const paint = (value: string, code: number): string =>
		useColor ? `\u001b[${code}m${value}\u001b[0m` : value;
	const stats = report.routeStats ?? {
		totalDistance: 0,
		totalElevationGain: 0,
		maxGradient: 0,
	};
	const lines = [
		`GPX route report: ${report.routeName}`,
		`Distance: ${km(stats.totalDistance)} km | Elevation gain: ${stats.totalElevationGain.toFixed(0)} m | Max gradient: ${stats.maxGradient.toFixed(1)}%`,
	];
	for (const [source, availability] of Object.entries(report.availability)) {
		if (source === "incomplete") continue;
		lines.push(
			`  ${source}: ${availability.status} (${availability.availableItems}/${availability.requestedItems})${availability.message ? ` — ${availability.message}` : ""}`,
		);
	}
	if (report.results.length > 0) {
		lines.push("", "Findings:");
		const ranges = groupContiguousResults(report.results);
		const trackCoords = report.trackCoords || [];

		// Show enabled/disabled status per rule
		lines.push("  Rules:");
		for (const [ruleId, ruleInfo] of Object.entries(report.rules)) {
			const status = ruleInfo.enabled ? "enabled" : "disabled";
			const stats = [ruleInfo.failures, ruleInfo.unknown, ruleInfo.skipped]
				.filter((n) => n > 0)
				.join(", ");
			lines.push(`    ${ruleId}: ${status}${stats ? ` (${stats})` : ""}`);
		}

		for (const item of ranges) {
			let position = "";
			if (item.startIndex !== undefined && trackCoords[item.startIndex]) {
				const distStart = km(trackCoords[item.startIndex].distanceFromStart);
				const distEnd = item.endIndex !== item.startIndex && trackCoords[item.endIndex]
					? km(trackCoords[item.endIndex].distanceFromStart)
					: null;
				position = distEnd
					? ` [${distStart}–${distEnd} km]`
					: ` [${distStart} km]`;
			} else if (item.startLat !== undefined && item.startLon !== undefined) {
				position = ` [${item.startLat.toFixed(6)}, ${item.startLon.toFixed(6)}]`;
				if (item.endLat !== undefined && item.endLon !== undefined && item.endIndex !== item.startIndex) {
					position += `–[${item.endLat.toFixed(6)}, ${item.endLon.toFixed(6)}]`;
				}
			}
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
			const enabledTag = report.rules[item.ruleId]?.enabled
				? ""
				: " [disabled]";
			lines.push(
				`  ${paint(item.status.toUpperCase(), statusCode)} ${paint(item.severity.toUpperCase(), severityCode)} ${item.ruleId}${position}: ${item.message}${source}${enabledTag}`,
			);
		}
	}
	lines.push(`Exit code: ${report.exitCode}`);
	return `${lines.join("\n")}\n`;
}
