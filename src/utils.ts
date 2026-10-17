/**
 * Shared utility functions used across the codebase.
 *
 * This module centralizes helpers that are duplicated across multiple modules:
 * - `isRecord` — type guard for non-null, non-array objects
 * - `errorMessage` — extracts error messages from unknown values
 * - `retryAfterMilliseconds` — parses HTTP Retry-After headers
 * - `splitIntoSegments` — splits trackpoints by segmentId
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

export function splitIntoSegments<T extends { segmentId: number }>(
	points: T[],
): T[][] {
	const segments: T[][] = [];
	for (const point of points) {
		const current = segments[segments.length - 1];
		if (!current || current[0].segmentId !== point.segmentId)
			segments.push([point]);
		else current.push(point);
	}
	return segments;
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function minimum(values: number[]): number {
	return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}
