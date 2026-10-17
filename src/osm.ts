import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CacheStats, DataSourceAvailability, MatchResult, Trackpoint } from './types'
import { bearingDegrees, pointToGeometryDistanceMeters } from './geo'

const OVERPASS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const OVERPASS_TIMEOUT_MS = 25_000
const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter'
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter'

interface OsmWay {
  id: number
  tags: Record<string, string>
  geometry: { lat: number; lon: number }[]
}

interface OsmCacheEntry {
  ways: OsmWay[]
  provider: string
  fetchedAt: number
}

export interface OsmEnrichmentResult {
  matches: MatchResult[]
  availability: DataSourceAvailability
  providerErrors: string[]
  cache: CacheStats
  cacheError?: string
}

export async function enrichWithOsm(
  points: Trackpoint[],
  matches: MatchResult[],
  options: { url?: string; fetcher?: typeof fetch; cache?: boolean; cacheDir?: string } = {}
): Promise<OsmEnrichmentResult> {
  const cache = { hits: 0, misses: 0 }
  let cacheError: string | undefined
  if (points.length === 0 || points.length !== matches.length) {
    return {
      matches,
      availability: {
        status: points.length === 0 ? 'not_required' : 'unavailable',
        source: options.url ?? OVERPASS_PRIMARY,
        requestedItems: points.length,
        availableItems: 0,
        message: 'No matched route points are available for OSM enrichment.'
      },
      providerErrors: [],
      cache
    }
  }
  const eligible = matches.filter(match => match.status === 'matched' && (match.confidence === 'high' || match.confidence === 'medium')).length
  if (eligible === 0) {
    return {
      matches,
      availability: {
        status: 'unavailable',
        source: options.url ?? OVERPASS_PRIMARY,
        requestedItems: points.length,
        availableItems: 0,
        message: 'No sufficiently confident road matches are available for OSM enrichment.'
      },
      providerErrors: [],
      cache
    }
  }

  const queries = splitIntoSegments(points).flatMap(segment => splitIntoBatches(segment, 50)).map(batch => {
    const bbox = routeBbox(batch)
    return `[out:json][timeout:25];way(${bbox})["highway"];out body geom;`
  })
  const cachePath = path.join(options.cacheDir ?? path.join(os.homedir(), '.cache', 'gpxlint'), 'osm-cache.json')
  const cacheKey = createHash('sha256').update(queries.join('\n')).digest('hex')
  const cacheEnabled = options.cache !== false
  let entries: Record<string, OsmCacheEntry> = {}
  if (cacheEnabled) {
    try {
      entries = await readOsmCache(cachePath)
    } catch (error) {
      cacheError = `Unable to read OSM cache: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const urls = options.url ? [options.url] : [OVERPASS_PRIMARY, OVERPASS_FALLBACK]
  const fetcher = options.fetcher ?? fetch
  const errors: string[] = []
  let ways: OsmWay[] | null = null
  const suppliedBy = new Set<string>()
  let completedQueries = 0
  const cached = entries[cacheKey]
  if (cacheEnabled && cached && Date.now() - cached.fetchedAt >= 0 && Date.now() - cached.fetchedAt < OVERPASS_TTL_MS) {
    ways = cached.ways
    suppliedBy.add(cached.provider)
    completedQueries = queries.length
    cache.hits++
  } else {
    if (cacheEnabled) cache.misses++
    ways = []
    const waysById = new Map<number, OsmWay>()
    let lastRequestAt = 0
    for (const query of queries) {
      let batchWays: OsmWay[] | null = null
      for (const url of urls) {
        const rateLimitWait = 1000 - (Date.now() - lastRequestAt)
        if (lastRequestAt > 0 && rateLimitWait > 0) await wait(rateLimitWait)
        lastRequestAt = Date.now()
        const response = await requestOverpass(url, query, fetcher)
        lastRequestAt = Date.now()
        if (response.error) {
          errors.push(`${url}: ${response.error}`)
          continue
        }
        const parsed = parseWays(response.text)
        if (!parsed) {
          errors.push(`${url}: Overpass returned malformed or unusable data.`)
          continue
        }
        batchWays = parsed
        suppliedBy.add(url)
        break
      }
      if (batchWays !== null) {
        completedQueries++
        for (const way of batchWays) waysById.set(way.id, way)
      }
    }
    ways.push(...waysById.values())
    if (completedQueries === 0) ways = null
  }

  if (ways === null) {
    return {
      matches,
      availability: {
        status: 'unavailable',
        source: [...suppliedBy].join(', ') || urls.join(', '),
        requestedItems: points.length,
        availableItems: 0,
        message: errors.join('; ')
      },
      providerErrors: errors,
      cache,
      cacheError
    }
  }

  let availableItems = 0
  const enriched = matches.map((match, index) => {
    if (match.status !== 'matched' || match.confidence === 'low' || match.confidence === 'unknown') return match
    const nearest = ways!.map(way => ({
      way,
      distance: pointToGeometryDistanceMeters(points[index], {
        type: 'LineString',
        coordinates: way.geometry.map(position => [position.lon, position.lat] as [number, number])
      })
    }))
      .filter(candidate => candidate.distance <= 30)
      .sort((a, b) => a.distance - b.distance)
    if (nearest.length === 0) {
      return {
        ...match,
        status: 'unmatched',
        confidence: 'unknown',
        reason: 'No OSM road geometry was found within 30m of the matched point.',
        candidates: []
      } satisfies MatchResult
    }
    const ambiguous = nearest.length > 1 && nearest[1].distance - nearest[0].distance <= 2
    const selected = nearest[0]
    if (ambiguous) {
      return {
        ...match,
        status: 'ambiguous',
        confidence: 'low',
        reason: 'Multiple nearby OSM roads have similarly plausible distances.',
        candidates: nearest.slice(0, 5).map(candidate => ({
          roadId: String(candidate.way.id),
          score: Math.max(0, 1 - candidate.distance / 30),
          highway: candidate.way.tags.highway,
          distanceToRoad: candidate.distance
        }))
      } satisfies MatchResult
    }
    availableItems++
    const nextPoint = points[index + 1]?.segmentId === points[index].segmentId
      ? points[index + 1]
      : points[index - 1]?.segmentId === points[index].segmentId
        ? points[index - 1]
        : undefined
    const routeBearing = nextPoint
      ? index + 1 < points.length && nextPoint === points[index + 1]
        ? bearingDegrees(points[index], nextPoint)
        : bearingDegrees(nextPoint, points[index])
      : undefined
    const wayDirection = routeBearing === undefined ? 'unknown' : roadDirection(points[index], routeBearing, selected.way.geometry)
    return {
      ...match,
      roadId: String(selected.way.id),
      roadName: selected.way.tags.name,
      osmDistanceToRoad: selected.distance,
      tags: selected.way.tags,
      direction: wayDirection,
      provider: `${match.provider ?? 'routing'} + osm:${[...suppliedBy].join(', ')}`
    } satisfies MatchResult
  })
  const providerName = [...suppliedBy].join(', ') || cached?.provider || urls[0]
  const availability: DataSourceAvailability = {
    status: completedQueries < queries.length
      ? availableItems > 0 ? 'partial' : 'unavailable'
      : availableItems === points.length ? 'complete' : availableItems > 0 ? 'partial' : 'unavailable',
    source: providerName,
    requestedItems: points.length,
    availableItems,
    message: availableItems === points.length ? undefined : `${points.length - availableItems} route point(s) were not matched to complete OSM road data.`
  }
  if (cacheEnabled && availability.status === 'complete' && cache.misses > 0 && ways !== null) {
    entries[cacheKey] = { ways, provider: providerName, fetchedAt: Date.now() }
    try {
      await mkdir(path.dirname(cachePath), { recursive: true })
      await writeFile(cachePath, JSON.stringify(entries), 'utf8')
    } catch (error) {
      cacheError = `Unable to write OSM cache: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    matches: enriched,
    availability,
    providerErrors: errors,
    cache,
    cacheError
  }
}

function routeBbox(points: Trackpoint[]): string {
  const padding = 0.005
  let latMin = 90
  let lonMin = 180
  let latMax = -90
  let lonMax = -180
  for (const point of points) {
    latMin = Math.min(latMin, point.lat)
    lonMin = Math.min(lonMin, point.lon)
    latMax = Math.max(latMax, point.lat)
    lonMax = Math.max(lonMax, point.lon)
  }
  latMin = Math.max(-90, latMin - padding)
  lonMin = Math.max(-180, lonMin - padding)
  latMax = Math.min(90, latMax + padding)
  lonMax = Math.min(180, lonMax + padding)
  return `${latMin},${lonMin},${latMax},${lonMax}`
}

function splitIntoBatches<T>(values: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) batches.push(values.slice(index, index + size))
  return batches
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

function parseWays(text: string): OsmWay[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.elements)) return null
  const ways: OsmWay[] = []
  for (const element of parsed.elements) {
    if (!isRecord(element)) return null
    if (element.type !== 'way') continue
    if (typeof element.id !== 'number' || !Number.isSafeInteger(element.id) || !isRecord(element.tags) || !Array.isArray(element.geometry)) return null
    const geometry: OsmWay['geometry'] = []
    for (const position of element.geometry) {
      if (!isRecord(position) || typeof position.lat !== 'number' || !Number.isFinite(position.lat)
        || typeof position.lon !== 'number' || !Number.isFinite(position.lon)) return null
      geometry.push({ lat: position.lat, lon: position.lon })
    }
    if (geometry.length < 2) return null
    const tags: Record<string, string> = {}
    for (const [key, value] of Object.entries(element.tags)) {
      if (typeof value !== 'string') return null
      tags[key] = value
    }
    ways.push({ id: element.id, tags, geometry })
  }
  return ways
}

async function readOsmCache(cachePath: string): Promise<Record<string, OsmCacheEntry>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    if (!isRecord(parsed)) throw new Error('cache file root is not an object')
    const entries: Record<string, OsmCacheEntry> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!isRecord(value) || typeof value.provider !== 'string'
        || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)
        || !Array.isArray(value.ways) || !value.ways.every(isOsmWay)) {
        throw new Error(`invalid OSM cache entry "${key}"`)
      }
      entries[key] = { provider: value.provider, fetchedAt: value.fetchedAt, ways: value.ways }
    }
    return entries
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {}
    throw error
  }
}

function isOsmWay(value: unknown): value is OsmWay {
  if (!isRecord(value) || typeof value.id !== 'number' || !Number.isSafeInteger(value.id)
    || !isRecord(value.tags) || !Array.isArray(value.geometry) || value.geometry.length < 2) return false
  return Object.values(value.tags).every(tag => typeof tag === 'string')
    && value.geometry.every(position => isRecord(position)
      && typeof position.lat === 'number' && Number.isFinite(position.lat)
      && typeof position.lon === 'number' && Number.isFinite(position.lon))
}

function roadDirection(
  point: Trackpoint,
  routeBearing: number,
  geometry: { lat: number; lon: number }[]
): 'forward' | 'backward' | 'unknown' {
  let nearestIndex = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  for (let index = 1; index < geometry.length; index++) {
    const distance = pointToGeometryDistanceMeters(point, {
      type: 'LineString',
      coordinates: [geometry[index - 1], geometry[index]].map(position => [position.lon, position.lat] as [number, number])
    })
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestIndex = index
    }
  }
  if (nearestIndex < 1) return 'unknown'
  const roadBearing = bearingDegrees(geometry[nearestIndex - 1], geometry[nearestIndex])
  const angularDifference = Math.abs(((routeBearing - roadBearing + 540) % 360) - 180)
  return angularDifference <= 90 ? 'forward' : 'backward'
}

async function requestOverpass(
  url: string,
  query: string,
  fetcher: typeof fetch
): Promise<{ text: string; error?: string }> {
  let lastError = 'Request failed.'
  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      if (attempt === 0) {
        await wait(1000)
        continue
      }
      return { text: '', error: lastError }
    }
    if (response.ok) {
      try {
        return { text: await response.text() }
      } catch (error) {
        return { text: '', error: `Unable to read Overpass response: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    lastError = `HTTP ${response.status} ${response.statusText}`.trim()
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt > 0) return { text: '', error: lastError }
    const delayMs = parseRetryAfter(response.headers.get('retry-after'))
    if (delayMs === null) return { text: '', error: lastError }
    await wait(delayMs)
  }
  return { text: '', error: lastError }
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return 1000
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= 5000 ? milliseconds : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

export const osmCacheTtlMilliseconds = OVERPASS_TTL_MS
