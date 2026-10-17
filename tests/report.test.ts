import { describe, expect, it } from 'vitest'
import { createReport, formatReport } from '../src/reporter'

describe('reporting', () => {
  it('does not let an unknown rule outcome produce a clean exit status', () => {
    const report = createReport({
      routeName: 'test.gpx',
      results: [{
        ruleId: 'max_slope',
        status: 'unknown',
        severity: 'error',
        confidence: 'low',
        message: 'Elevation data missing'
      }],
      availability: {
        gpx: { status: 'complete', source: 'file', requestedItems: 1, availableItems: 1 },
        roadMatching: { status: 'not_required', source: 'routing', requestedItems: 0, availableItems: 0 },
        osm: { status: 'not_required', source: 'overpass', requestedItems: 0, availableItems: 0 },
        roadworks: { status: 'not_required', source: 'geojson', requestedItems: 0, availableItems: 0 },
        incomplete: false
      },
      cache: { hits: 0, misses: 0 }
    })
    expect(report.availability.incomplete).toBe(true)
    expect(report.exitCode).toBe(2)
  })

  it('preserves unknown outcomes and assigns incomplete exit status', () => {
    const report = createReport({
      routeName: 'test.gpx',
      results: [{
        ruleId: 'contraflow_bike',
        status: 'unknown',
        severity: 'error',
        confidence: 'low',
        message: 'Road matching unavailable',
        source: { provider: 'osrm' }
      }],
      availability: {
        gpx: { status: 'complete', source: 'file', requestedItems: 1, availableItems: 1 },
        roadMatching: { status: 'unavailable', source: 'osrm', requestedItems: 1, availableItems: 0 },
        osm: { status: 'not_required', source: 'overpass', requestedItems: 0, availableItems: 0 },
        roadworks: { status: 'not_required', source: 'geojson', requestedItems: 0, availableItems: 0 },
        incomplete: true
      },
      cache: { hits: 0, misses: 1 }
    })
    const json = JSON.parse(formatReport(report, 'json'))

    expect(json.summary.status.unknown).toBe(1)
    expect(json.exitCode).toBe(2)
    expect(formatReport(report, 'text')).toContain('Road matching unavailable')
  })
})
