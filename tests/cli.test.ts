import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCheck } from '../src/cli'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

describe('check command', () => {
  it('writes a JSON report and returns the validation exit code', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gpxlint-cli-'))
    directories.push(directory)
    const gpxFile = path.join(directory, 'steep.gpx')
    const configFile = path.join(directory, 'gpxlint.yml')
    const outputFile = path.join(directory, 'report.json')
    await writeFile(gpxFile, `<gpx><trk><trkseg>
      <trkpt lat="48" lon="2"><ele>0</ele></trkpt>
      <trkpt lat="48" lon="2.001"><ele>0</ele></trkpt>
      <trkpt lat="48" lon="2.002"><ele>20</ele></trkpt>
    </trkseg></trk></gpx>`)
    await writeFile(configFile, `rules:
  max_slope:
    enabled: true
    params:
      max_percent: 10
  contraflow_bike: { enabled: false }
  roadworks: { enabled: false }
  sharp_turn: { enabled: false }
  off_road: { enabled: false }
  missing_elevation: { enabled: false }
  route_gaps: { enabled: false }
  loop_closure: { enabled: false }
`)

    const exitCode = await runCheck(gpxFile, { config: configFile, format: 'json', output: outputFile })
    const report = JSON.parse(await readFile(outputFile, 'utf8'))

    expect(exitCode).toBe(1)
    expect(report.summary.status.fail).toBe(1)
    expect(report.results[0].ruleId).toBe('max_slope')
  })

  it('returns fatal input status when GPX cannot be parsed', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gpxlint-cli-'))
    directories.push(directory)
    const gpxFile = path.join(directory, 'broken.gpx')
    await writeFile(gpxFile, '<gpx><trk>')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runCheck(gpxFile)).resolves.toBe(3)
  })

  it('continues GPX-only rules when road matching is unavailable', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gpxlint-cli-'))
    directories.push(directory)
    const gpxFile = path.join(directory, 'route.gpx')
    const configFile = path.join(directory, 'gpxlint.yml')
    const outputFile = path.join(directory, 'report.json')
    await writeFile(gpxFile, `<gpx><trk><trkseg>
      <trkpt lat="48" lon="2"><ele>0</ele></trkpt>
      <trkpt lat="48" lon="2.001"><ele>0</ele></trkpt>
    </trkseg></trk></gpx>`)
    await writeFile(configFile, `rules:
  max_slope: { enabled: true }
  contraflow_bike: { enabled: true }
  roadworks: { enabled: false }
  sharp_turn: { enabled: false }
  off_road: { enabled: false }
  missing_elevation: { enabled: false }
  route_gaps: { enabled: false }
  loop_closure: { enabled: false }
routing:
  provider: offline
`)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const exitCode = await runCheck(gpxFile, {
      config: configFile,
      format: 'json',
      output: outputFile,
      cache: false
    })
    const report = JSON.parse(await readFile(outputFile, 'utf8'))

    expect(exitCode).toBe(2)
    expect(report.availability.roadMatching.status).toBe('unavailable')
    expect(report.results).toContainEqual(expect.objectContaining({
      ruleId: 'max_slope',
      status: 'pass'
    }))
    expect(report.results).toContainEqual(expect.objectContaining({
      ruleId: 'contraflow_bike',
      status: 'unknown'
    }))
  })
})
