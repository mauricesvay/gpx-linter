import { describe, expect, it } from 'vitest'
import { parseGpx } from '../src/gpxParser'

describe('parseGpx', () => {
  it('preserves multiple tracks and segments while parsing optional data', () => {
    const parsed = parseGpx(`<?xml version="1.0"?>
      <gpx version="1.1" creator="unit-test">
        <metadata><name>Two rides</name></metadata>
        <trk><name>First</name>
          <trkseg>
            <trkpt lat="48.1" lon="2.1"><ele>35.5</ele><time>2025-01-01T10:00:00Z</time></trkpt>
            <trkpt lat="48.1001" lon="2.1001"/>
          </trkseg>
          <trkseg><trkpt lat="48.2" lon="2.2"><ele>42</ele></trkpt></trkseg>
        </trk>
        <trk><trkseg><trkpt lat="48.3" lon="2.3"><ele>30</ele></trkpt></trkseg></trk>
      </gpx>`)

    expect(parsed.tracks).toHaveLength(2)
    expect(parsed.tracks[0].segments).toHaveLength(2)
    expect(parsed.points).toHaveLength(4)
    expect(parsed.points[0]).toMatchObject({ lat: 48.1, lon: 2.1, ele: 35.5 })
    expect(parsed.points[1].ele).toBeNull()
    expect(parsed.metadata.gpxName).toBe('Two rides')
    expect(parsed.metadata.gpxCreator).toBe('unit-test')
  })

  it('rejects malformed coordinates and files without trackpoints', () => {
    expect(() => parseGpx('<gpx><trk><trkseg><trkpt lat="91" lon="2"/></trkseg></trk></gpx>'))
      .toThrow(/coordinate/i)
    expect(() => parseGpx('<gpx><wpt lat="1" lon="2"/></gpx>')).toThrow(/trackpoint/i)
  })

  it('computes cumulative distances without connecting separate segments', () => {
    const parsed = parseGpx(`<gpx><trk>
      <trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="0.01"/></trkseg>
      <trkseg><trkpt lat="1" lon="1"/></trkseg>
    </trk></gpx>`)

    expect(parsed.points[1].distanceFromStart).toBeGreaterThan(1000)
    expect(parsed.points[2].distanceFromStart).toBe(parsed.points[1].distanceFromStart)
  })
})
