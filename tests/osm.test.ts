import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enrichWithOsm } from '../src/osm'
import { point } from './fixtures'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('OSM enrichment', () => {
  it('uses queried road tags and retains the matched way identity', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      elements: [{
        type: 'way',
        id: 765,
        tags: { highway: 'residential', oneway: 'yes', name: 'Test Street' },
        geometry: [{ lat: 48, lon: 2 }, { lat: 48, lon: 2.001 }]
      }]
    }), { status: 200 }))
    const enriched = await enrichWithOsm([point(48, 2.0005)], [{
      status: 'matched', confidence: 'high', score: 0.9,
      distanceToRoad: 1, provider: 'osrm'
    }], { url: 'https://overpass.invalid', fetcher, cache: false })

    expect(enriched.availability.status).toBe('complete')
    expect(enriched.matches[0]).toMatchObject({
      roadId: '765',
      roadName: 'Test Street',
      tags: { oneway: 'yes' }
    })
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST')
  })

  it('returns unavailable and keeps matches uncertain for a malformed response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    const input = [{ status: 'matched' as const, confidence: 'high' as const, score: 0.9 }]
    const result = await enrichWithOsm([point(48, 2)], input, {
      url: 'https://overpass.invalid', fetcher, cache: false
    })
    expect(result.availability.status).toBe('unavailable')
    expect(result.matches[0].tags).toBeUndefined()
  })

  it('caches complete Overpass responses for subsequent enrichment', async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'gpxlint-osm-cache-'))
    directories.push(cacheDir)
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      elements: [{
        type: 'way',
        id: 765,
        tags: { highway: 'residential' },
        geometry: [{ lat: 48, lon: 2 }, { lat: 48, lon: 2.001 }]
      }]
    }), { status: 200 }))
    const points = [point(48, 2.0005)]
    const matches = [{ status: 'matched' as const, confidence: 'high' as const, score: 0.9 }]
    const options = { url: 'https://overpass.invalid', fetcher, cacheDir }

    const first = await enrichWithOsm(points, matches, options)
    const second = await enrichWithOsm(points, matches, options)

    expect(first.cache.misses).toBe(1)
    expect(second.cache.hits).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
