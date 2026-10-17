/**
 * Shared utility functions used across the codebase.
 *
 * This module centralizes helpers that are duplicated across multiple modules:
 * - `isRecord` — type guard for non-null, non-array objects
 * - `errorMessage` — extracts error messages from unknown values
 * - `retryAfterMilliseconds` — parses HTTP Retry-After headers
 * - `delay` — promisified setTimeout
 * - `minimum` — returns min of array or positive infinity
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Alias for resolver.ts compatibility
export const message = errorMessage;

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function retryAfterMilliseconds(value: string | null): number | null {
	if (value === null) return 1000;
	const seconds = Number(value);
	const milliseconds = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(value) - Date.now();
	if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 5000)
		return null;
	return milliseconds;
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function truncateText(value: string, maxLength = 160): string {
	const cleaned = value.replace(/\s+/g, " ").trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, maxLength - 1)}…`;
}

/**
 * Builds a compact, human-readable suffix from an HTTP response body so
 * provider errors explain *why* the request failed (e.g. a JSON
 * `{"message":"..."}` payload).
 */
export function responseBodyDetail(body: string, maxLength = 160): string {
	const text = body.trim();
	if (text.length === 0) return "";
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && typeof parsed.message === "string") {
			return `: ${truncateText(parsed.message, maxLength)}`;
		}
	} catch {
		// Not JSON; fall through to a plain snippet.
	}
	return `: ${truncateText(text, maxLength)}`;
}

export function minimum(values: number[]): number {
	return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

/**
 * Maps a 0-1 match score onto a confidence level.
 * Shared by the routing providers and the local OSM snapper.
 */
export function confidenceFromScore(score: number): "high" | "medium" | "low" {
	if (score >= 0.8) return "high";
	if (score >= 0.6) return "medium";
	return "low";
}
