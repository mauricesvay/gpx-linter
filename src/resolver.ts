import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CacheStats,
  DataSourceAvailability,
  MatchResult,
  Trackpoint
} from './types'
import { distanceMeters } from './geo'

const ROAD_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_SNAP_DISTANCE_METERS = 100

interface CacheEntry {
  storedAt: number
  result: MatchResult
}

interface ResolverOptions {
  provider?: 'osrm' | 'graphhopper' | 'offline'
  fallback?: 'osrm' | 'graphhopper'
  url?: string
  osrmUrl?: string
  graphhopperUrl?: string
  batchSize?: number
  cache?: boolean
  cacheDir?: string
  fetcher?: typeof fetch
}

export interface ResolutionResult {
  matches: MatchResult[]
  availability: DataSourceAvailability
  cache: CacheStats
  providerErrors: string[]
  cacheError?: string
}

export async function resolveRoads(points: Trackpoint[], options: ResolverOptions = {}): Promise<ResolutionResult> {
  const cacheStats = { hits: 0, misses: 0 }
  const errors: string[] = []
  const cacheEnabled = options.cache !== false
  const cachePath = path.join(options.cacheDir ?? path.join(os.homedir(), '.cache', 'gpxlint'), 'cache.json')
  let cache: Record<string, CacheEntry> = {}
  let cacheError: string | undefined
  if (cacheEnabled) {
    try {
      cache = await readCache(cachePath)
    } catch (error) {
      cacheError = `Unable to read road cache: ${message(error)}`
    }
  }

  const now = Date.now()
  const matches: (MatchResult | undefined)[] = new Array(points.length)
  const misses: Trackpoint[] = []
  const missIndexes: number[] = []
  for (let i = 0; i < points.length; i++) {
    const key = cacheKey(points[i])
    const entry = cache[key]
    if (cacheEnabled && entry && now - entry.storedAt >= 0
      && now - entry.storedAt < ROAD_CACHE_TTL_MS && isUsableCacheEntry(entry.result)) {
      matches[i] = { ...entry.result, provider: entry.result.provider ?? 'cache' }
      cacheStats.hits++
    } else {
      misses.push(points[i])
      missIndexes.push(i)
      if (cacheEnabled) cacheStats.misses++
    }
  }

  let provider = options.provider ?? 'osrm'
  const primary = provider
  if (options.url) {
    if (provider === 'osrm') options.osrmUrl = options.url
    else options.graphhopperUrl = options.url
  }
  if (provider !== 'offline' && misses.length > 0) {
    let resolved = await resolveProvider(misses, provider, options)
    if (resolved.error) errors.push(`${provider}: ${resolved.error}`)
    if (resolved.results === null && options.fallback && options.fallback !== provider) {
      provider = options.fallback
      resolved = await resolveProvider(misses, provider, options)
      if (resolved.error) errors.push(`${provider}: ${resolved.error}`)
    }
    if (resolved.results) {
      resolved.results.forEach((match, index) => {
        matches[missIndexes[index]] = match
        if (cacheEnabled && isUsableCacheEntry(match)) {
          cache[cacheKey(misses[index])] = { storedAt: now, result: match }
        }
      })
      if (options.fallback && options.fallback !== provider) {
        const uncoveredIndexes = resolved.results
          .map((match, index) => match.status === 'unmatched' ? index : -1)
          .filter(index => index >= 0)
        if (uncoveredIndexes.length > 0) {
          const fallbackProvider = options.fallback
          const fallbackResult = await resolveProvider(uncoveredIndexes.map(index => misses[index]), fallbackProvider, options)
          if (fallbackResult.error) errors.push(`${fallbackProvider}: ${fallbackResult.error}`)
          if (fallbackResult.results) {
            fallbackResult.results.forEach((match, index) => {
              const missIndex = uncoveredIndexes[index]
              matches[missIndexes[missIndex]] = match
              if (cacheEnabled && isUsableCacheEntry(match)) {
                cache[cacheKey(misses[missIndex])] = { storedAt: now, result: match }
              }
            })
            provider = fallbackProvider
          }
        }
      }
    }
  } else if (misses.length > 0) {
    errors.push('offline: No offline road-matching backend is configured.')
  }

  const finalMatches: MatchResult[] = Array.from(matches, match => match ?? ({
    status: 'unmatched',
    confidence: 'unknown',
    score: 0,
    reason: 'No usable match was returned by the configured routing provider.',
    provider: primary
  }))
  if (cacheEnabled && cacheStats.misses > 0) {
    try {
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, JSON.stringify(cache), 'utf8')
    } catch (error) {
      cacheError = `Unable to write road cache: ${message(error)}`
    }
  }

  const availableItems = finalMatches.filter(match => match.status === 'matched').length
  const unknownItems = finalMatches.filter(match => match.status !== 'matched' || match.confidence === 'low' || match.confidence === 'unknown').length
  const availability: DataSourceAvailability = {
    status: points.length === 0 || availableItems === 0
      ? 'unavailable'
      : unknownItems > 0
        ? 'partial'
        : 'complete',
    source: provider,
    requestedItems: points.length,
    availableItems
  }
  if (errors.length > 0) availability.message = errors.join('; ')
  else if (unknownItems > 0) availability.message = `${unknownItems} trackpoint(s) could not be matched with sufficient confidence.`
  return { matches: finalMatches, availability, cache: cacheStats, providerErrors: errors, cacheError }
}

async function resolveProvider(
  points: Trackpoint[],
  provider: 'osrm' | 'graphhopper',
  options: ResolverOptions
): Promise<{ results: MatchResult[] | null; error?: string }> {
  const baseUrl = provider === 'osrm'
    ? options.osrmUrl ?? 'https://router.project-osrm.org'
    : options.graphhopperUrl ?? 'http://localhost:8989'
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 50, provider === 'osrm' ? 100 : 100))
  const output: MatchResult[] = []
  const fetcher = options.fetcher ?? fetch
  for (const segment of splitIntoSegments(points)) {
    for (let start = 0; start < segment.length; start += batchSize) {
      const batch = segment.slice(start, start + batchSize)
      const request = provider === 'osrm'
        ? osrmRequest(baseUrl, batch)
        : graphhopperRequest(baseUrl, batch)
      const response = await requestJson(request.url, request.init, fetcher)
      if (response.error) return { results: null, error: response.error }
      let parsed: unknown
      try {
        parsed = JSON.parse(response.text)
      } catch {
        return { results: null, error: 'Provider returned malformed JSON.' }
      }
      const batchResults = provider === 'osrm'
        ? parseOsrm(parsed, batch)
        : parseGraphhopper(parsed, batch)
      if (!batchResults) return { results: null, error: 'Provider response was invalid or did not correspond to the requested coordinates.' }
      output.push(...batchResults.map(result => ({ ...result, provider })))
    }
  }
  return { results: output }
}

function osrmRequest(baseUrl: string, points: Trackpoint[]): { url: string; init?: RequestInit } {
  const coordinates = points.map(point => `${point.lon},${point.lat}`).join(';')
  const url = new URL(`/match/v1/driving/${coordinates}`, ensureUrl(baseUrl))
  url.searchParams.set('overview', 'false')
  url.searchParams.set('annotations', 'true')
  return { url: url.toString() }
}

function graphhopperRequest(baseUrl: string, points: Trackpoint[]): { url: string; init: RequestInit } {
  const url = new URL('/match', ensureUrl(baseUrl))
  url.searchParams.set('profile', 'bike')
  url.searchParams.set('points_encoded', 'false')
  const body = points.map(point => `point=${encodeURIComponent(`${point.lat},${point.lon}`)}`).join('&')
  return {
    url: url.toString(),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body
    }
  }
}

async function requestJson(
  url: string,
  init: RequestInit | undefined,
  fetcher: typeof fetch
): Promise<{ text: string; error?: string }> {
  let lastError = 'Request failed.'
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      lastError = message(error)
      if (attempt === 0 && isRetryableNetworkError(error)) {
        await delay(1000)
        continue
      }
      return { text: '', error: lastError }
    }
    if (response.ok) {
      try {
        return { text: await response.text() }
      } catch (error) {
        return { text: '', error: `Unable to read provider response: ${message(error)}` }
      }
    }
    lastError = `HTTP ${response.status} ${response.statusText}`.trim()
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt > 0) return { text: '', error: lastError }
    const wait = retryAfterMilliseconds(response.headers.get('retry-after'))
    if (wait === null) return { text: '', error: lastError }
    await delay(wait)
  }
  return { text: '', error: lastError }
}

function parseOsrm(payload: unknown, points: Trackpoint[]): MatchResult[] | null {
  const root = asRecord(payload)
  if (!root || root.code !== 'Ok' || !Array.isArray(root.tracepoints) || !Array.isArray(root.matchings)) return null
  if (root.tracepoints.length !== points.length) return null
  const results: MatchResult[] = []
  for (const [index, raw] of root.tracepoints.entries()) {
    if (raw === null) {
      results.push({ status: 'unmatched', confidence: 'unknown', score: 0, reason: 'OSRM could not match this trackpoint.' })
      continue
    }
    const tracepoint = asRecord(raw)
    const location = tracepoint?.location
    const matchIndex = tracepoint?.matchings_index
    if (!tracepoint || !Array.isArray(location) || location.length < 2 || !isFiniteCoordinate(location[0]) || !isFiniteCoordinate(location[1])) return null
    const snappedDistance = distanceMeters(points[index], { lon: location[0], lat: location[1] })
    if (snappedDistance > MAX_SNAP_DISTANCE_METERS) return null
    if (typeof matchIndex !== 'number' || !Number.isInteger(matchIndex)) return null
    const matching = asRecord(root.matchings[matchIndex])
    const score = matching?.confidence
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return null
    const confidence = confidenceFromScore(score)
    const waypointIndex = tracepoint.waypoint_index
    const roadId = typeof waypointIndex === 'number' ? `osrm:${matchIndex}:${waypointIndex}` : `osrm:${index}`
    const distance = snappedDistance
    results.push({
      status: confidence === 'low' ? 'ambiguous' : 'matched',
      confidence,
      score,
      distanceToRoad: distance,
      reason: confidence === 'low' ? 'OSRM match confidence is below the medium-confidence threshold.' : undefined,
      roadId,
      candidates: [{ roadId, score, distanceToRoad: distance }]
    })
  }
  return results
}

function parseGraphhopper(payload: unknown, points: Trackpoint[]): MatchResult[] | null {
  const root = asRecord(payload)
  const matchingResponse = asRecord(root?.map_matching) ?? root
  if (!matchingResponse || !Array.isArray(matchingResponse.matchings) || !Array.isArray(matchingResponse.tracepoints)) return null
  if (matchingResponse.tracepoints.length !== points.length) return null
  const output: MatchResult[] = []
  for (const [index, raw] of matchingResponse.tracepoints.entries()) {
    if (raw === null) {
      output.push({ status: 'unmatched', confidence: 'unknown', score: 0, reason: 'GraphHopper could not match this trackpoint.' })
      continue
    }
    const tracepoint = asRecord(raw)
    const matchingIndex = tracepoint?.matchings_index ?? tracepoint?.matching_index
    if (!tracepoint || typeof matchingIndex !== 'number' || !Number.isInteger(matchingIndex)) return null
    const matching = asRecord(matchingResponse.matchings[matchingIndex])
    if (!matching || typeof matching.confidence !== 'number' || !Number.isFinite(matching.confidence)) return null
    const confidence = confidenceFromScore(matching.confidence)
    const roadId = `graphhopper:${matchingIndex}:${index}`
    output.push({
      status: confidence === 'low' ? 'ambiguous' : 'matched',
      confidence,
      score: matching.confidence,
      roadId,
      distanceToRoad: typeof tracepoint.distance === 'number' ? tracepoint.distance : undefined,
      reason: confidence === 'low' ? 'GraphHopper match confidence is below the medium-confidence threshold.' : undefined,
      candidates: [{ roadId, score: matching.confidence }]
    })
  }
  return output
}

function confidenceFromScore(score: number): MatchResult['confidence'] {
  if (score >= 0.8) return 'high'
  if (score >= 0.6) return 'medium'
  return 'low'
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (value === null) return 1000
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 5000) return null
  return milliseconds
}

function isRetryableNetworkError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error instanceof TypeError)
}

function isUsableCacheEntry(result: unknown): result is MatchResult {
  const entry = asRecord(result)
  return entry !== null
    && entry.status === 'matched'
    && (entry.confidence === 'high' || entry.confidence === 'medium')
    && typeof entry.score === 'number'
}

function cacheKey(point: Trackpoint): string {
  return createHash('sha256').update(`${point.lat},${point.lon}`).digest('hex')
}

async function readCache(cachePath: string): Promise<Record<string, CacheEntry>> {
  try {
    const raw = await readFile(cachePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) throw new Error('cache file root is not an object')
    const entries: Record<string, CacheEntry> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.storedAt !== 'number' || !Number.isFinite(value.storedAt)
        || !isUsableCacheEntry(value.result)) {
        throw new Error(`invalid cache entry "${key}"`)
      }
      entries[key] = { storedAt: value.storedAt, result: value.result }
    }
    return entries
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {}
    throw error
  }
}

function ensureUrl(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function splitIntoSegments(points: Trackpoint[]): Trackpoint[][] {
  const segments: Trackpoint[][] = []
  for (const point of points) {
    const current = segments[segments.length - 1]
    if (!current || current[0].segmentId !== point.segmentId) segments.push([point])
    else current.push(point)
  }
  return segments
}
