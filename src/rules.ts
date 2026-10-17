import { bearingDegrees, distanceMeters, isGeoJsonFeatureCollection, isWithinFeature } from './geo'
import type {
  Confidence,
  GeoJsonFeatureCollection,
  MatchResult,
  RuleContext,
  RuleDefinition,
  RuleResult,
  Severity,
  Trackpoint
} from './types'

const RULES: Record<string, { severity: Severity; requiresRoads?: boolean }> = {
  max_slope: { severity: 'error' },
  contraflow_bike: { severity: 'error', requiresRoads: true },
  roadworks: { severity: 'warning' },
  sharp_turn: { severity: 'warning' },
  off_road: { severity: 'error', requiresRoads: true },
  missing_elevation: { severity: 'info' },
  route_gaps: { severity: 'info' },
  loop_closure: { severity: 'info' }
}

export function evaluateRules(points: Trackpoint[], context: RuleContext = {}): RuleResult[] {
  const results: RuleResult[] = []
  const definitions = { ...context.rules }
  for (const [ruleId, metadata] of Object.entries(RULES)) {
    const definition = definitions[ruleId]
    if (!definition) continue
    if (definition.enabled === false) {
      results.push(result(ruleId, definition, metadata.severity, 'skipped', 'Rule is disabled.', 'high'))
      continue
    }
    if (metadata.requiresRoads) {
      results.push(...evaluateRoadRule(ruleId, definition, metadata.severity, points, context))
      continue
    }
    switch (ruleId) {
      case 'max_slope':
        results.push(...maxSlope(definition, points))
        break
      case 'roadworks':
        results.push(...roadworks(definition, points))
        break
      case 'sharp_turn':
        results.push(...sharpTurns(definition, points))
        break
      case 'missing_elevation':
        results.push(...missingElevation(definition, points))
        break
      case 'route_gaps':
        results.push(...routeGaps(definition, points, context))
        break
      case 'loop_closure':
        results.push(...loopClosure(definition, points, context))
        break
    }
  }
  for (const [ruleId, definition] of Object.entries(definitions)) {
    if (!(ruleId in RULES)) {
      if (definition.enabled === false) {
        results.push(result(ruleId, definition, definition.severity ?? 'info', 'skipped', 'Rule is disabled.', 'high'))
      } else {
        results.push(result(ruleId, definition, definition.severity ?? 'warning', 'unknown', `Unsupported rule template "${ruleId}".`, 'low'))
      }
    }
  }
  return results
}

function maxSlope(definition: RuleDefinition, points: Trackpoint[]): RuleResult[] {
  if (points.length < 2) return [result('max_slope', definition, 'error', 'unknown', 'At least two trackpoints are required to evaluate slope.', 'low')]
  const elevations = smoothElevations(points)
  const threshold = numberParam(definition, 'max_percent', 10)
  const results: RuleResult[] = []
  let evaluated = 0
  let missing = 0

  for (let i = 1; i < points.length; i++) {
    if (!sameSegment(points[i - 1], points[i])) continue
    const distance = distanceMeters(points[i - 1], points[i])
    if (distance < numberParam(definition, 'min_segment_meters', 3)) continue
    const before = elevations[i - 1]
    const after = elevations[i]
    if (before === null || after === null) {
      missing++
      continue
    }
    evaluated++
    const slope = (after - before) / distance * 100
    if (Math.abs(after - before) < numberParam(definition, 'min_elevation_delta_meters', 1.5)) continue
    if (Math.abs(slope) > threshold) {
      results.push(result(
        'max_slope',
        definition,
        'error',
        'fail',
        `Gradient ${slope.toFixed(1)}% exceeds the ${threshold}% limit.`,
        'high',
        points[i - 1],
        { slopePercent: Number(slope.toFixed(2)), thresholdPercent: threshold, distanceMeters: Number(distance.toFixed(1)), end: { lat: points[i].lat, lon: points[i].lon } }
      ))
    }
  }
  if (missing > 0) {
    results.push(result('max_slope', definition, 'error', 'unknown', `${missing} segment(s) lack elevation data; slope could not be checked.`, 'low', undefined, { missingSegments: missing }))
  }
  if (results.length === 0) {
    results.push(result(
      'max_slope',
      definition,
      'error',
      missing > 0 ? 'unknown' : evaluated === 0 ? 'unknown' : 'pass',
      missing > 0 ? 'Slope evaluation is incomplete because elevation is missing.' : evaluated === 0 ? 'No sufficiently long segments were available for slope evaluation.' : 'No segment exceeds the configured slope threshold.',
      missing > 0 || evaluated === 0 ? 'low' : 'high',
      undefined,
      { evaluatedSegments: evaluated, missingSegments: missing, thresholdPercent: threshold }
    ))
  }
  return results
}

function roadworks(definition: RuleDefinition, points: Trackpoint[]): RuleResult[] {
  const geoJson = definition.data ?? definition.params?.geojson
  if (!isFeatureCollection(geoJson)) {
    return [result('roadworks', definition, 'warning', 'unknown', 'Roadworks GeoJSON is not configured or is invalid.', 'low', undefined, { source: 'roadworks' })]
  }
  const buffer = numberParam(definition, 'buffer_meters', 5)
  const results: RuleResult[] = []
  for (const point of points) {
    for (const feature of geoJson.features) {
      if (!isWithinFeature(point, feature, buffer)) continue
      if (feature.geometry === null) continue
      const properties = feature.properties ?? {}
      const name = typeof properties.name === 'string' ? properties.name : 'Unnamed roadworks'
      results.push(result(
        'roadworks',
        definition,
        'warning',
        'fail',
        `Route is within ${buffer}m of roadworks: ${name}.`,
        'high',
        point,
        { name, type: properties.type ?? null, bufferMeters: buffer, geometryType: feature.geometry.type },
        { source: 'geojson' }
      ))
    }
  }
  if (results.length === 0) results.push(result(
    'roadworks', definition, 'warning', 'pass', 'No route point overlaps the configured roadworks buffer.', 'high',
    undefined, { featuresChecked: geoJson.features.length, bufferMeters: buffer }, { source: 'geojson' }
  ))
  return results
}

function sharpTurns(definition: RuleDefinition, points: Trackpoint[]): RuleResult[] {
  const limit = numberParam(definition, 'max_angle', 60)
  const minLength = numberParam(definition, 'min_segment_meters', 5)
  const minimumChange = numberParam(definition, 'min_heading_change_degrees', 0)
  const results: RuleResult[] = []
  let considered = 0
  for (let i = 1; i < points.length - 1; i++) {
    const before = points[i - 1]
    const current = points[i]
    const after = points[i + 1]
    if (!sameSegment(before, current) || !sameSegment(current, after)) continue
    const firstLength = distanceMeters(before, current)
    const secondLength = distanceMeters(current, after)
    if (firstLength < minLength || secondLength < minLength) continue
    const incoming = bearingDegrees(before, current)
    const outgoing = bearingDegrees(current, after)
    const rawAngle = Math.abs(outgoing - incoming)
    const change = Math.min(rawAngle, 360 - rawAngle)
    if (change < minimumChange) continue
    considered++
    if (change > limit) {
      results.push(result(
        'sharp_turn',
        definition,
        'warning',
        'fail',
        `Turn angle ${change.toFixed(1)}° exceeds the ${limit}° limit.`,
        'high',
        current,
        { angleDegrees: Number(change.toFixed(1)), thresholdDegrees: limit, incomingBearing: incoming, outgoingBearing: outgoing }
      ))
    }
  }
  if (results.length === 0) results.push(result(
    'sharp_turn', definition, 'warning', 'pass', 'No sharp turns exceed the configured threshold.', 'high',
    undefined, { consideredTurns: considered, thresholdDegrees: limit }
  ))
  return results
}

function missingElevation(definition: RuleDefinition, points: Trackpoint[]): RuleResult[] {
  const missingCount = points.filter(point => point.ele === null).length
  const missingPercent = points.length === 0 ? 100 : missingCount / points.length * 100
  const threshold = numberParam(definition, 'max_missing_percent', 20)
  const failed = missingPercent > threshold
  return [result(
    'missing_elevation', definition, 'info', failed ? 'fail' : 'pass',
    `${missingPercent.toFixed(1)}% of trackpoints lack elevation (${missingCount}/${points.length}); limit is ${threshold}%.`,
    'high', undefined,
    { missingCount, totalPoints: points.length, missingPercent: Number(missingPercent.toFixed(2)), thresholdPercent: threshold }
  )]
}

function routeGaps(definition: RuleDefinition, points: Trackpoint[], context: RuleContext): RuleResult[] {
  if (context.routeContext?.ferry_allowed) {
    return [result('route_gaps', definition, 'info', 'skipped', 'Route-gap checks are skipped because ferry segments are allowed.', 'high')]
  }
  const threshold = numberParam(definition, 'max_gap_meters', 500)
  const results: RuleResult[] = []
  let checked = 0
  for (let i = 1; i < points.length; i++) {
    if (!sameSegment(points[i - 1], points[i])) continue
    checked++
    const distance = distanceMeters(points[i - 1], points[i])
    if (distance > threshold) {
      results.push(result(
        'route_gaps', definition, 'info', 'fail',
        `Track jumps ${Math.round(distance)}m, exceeding the ${threshold}m continuity limit.`,
        'high', points[i - 1], { distanceMeters: Math.round(distance), thresholdMeters: threshold, end: { lat: points[i].lat, lon: points[i].lon } }
      ))
    }
  }
  if (results.length === 0) results.push(result(
    'route_gaps', definition, 'info', 'pass', 'No within-segment trackpoint gaps exceed the configured threshold.', 'high',
    undefined, { checkedGaps: checked, thresholdMeters: threshold }
  ))
  return results
}

function loopClosure(definition: RuleDefinition, points: Trackpoint[], context: RuleContext): RuleResult[] {
  if (!context.routeContext?.loop_expected) {
    return [result('loop_closure', definition, 'info', 'skipped', 'Loop closure is not applicable because this route is not marked as a loop.', 'high')]
  }
  if (points.length < 2) return [result('loop_closure', definition, 'info', 'unknown', 'At least two trackpoints are required to check loop closure.', 'low')]
  const start = points[0]
  const end = points[points.length - 1]
  const distance = distanceMeters(start, end)
  const threshold = numberParam(definition, 'max_return_distance_meters', 100)
  const failed = distance > threshold
  return [result(
    'loop_closure', definition, 'info', failed ? 'fail' : 'pass',
    `Route ends ${Math.round(distance)}m from its start; limit is ${threshold}m.`,
    'high', start, { distanceMeters: Math.round(distance), thresholdMeters: threshold, end: { lat: end.lat, lon: end.lon } }
  )]
}

function evaluateRoadRule(
  ruleId: string,
  definition: RuleDefinition,
  defaultSeverity: Severity,
  points: Trackpoint[],
  context: RuleContext
): RuleResult[] {
  if (ruleId === 'contraflow_bike' && context.roadMatching?.status === 'unavailable') {
    return [result(ruleId, definition, defaultSeverity, 'unknown', 'Road matching is unavailable; contraflow could not be evaluated.', 'low', undefined, undefined, { source: context.roadMatching.source })]
  }
  if (ruleId === 'off_road' && context.roadMatching?.status === 'unavailable') {
    return [result(ruleId, definition, defaultSeverity, 'unknown', 'Road matching is unavailable; distance to road could not be evaluated.', 'low', undefined, undefined, { source: context.roadMatching.source })]
  }
  const matches = ruleId === 'off_road'
    ? context.roadMatches ?? context.matches ?? []
    : context.matches ?? []
  if (matches.length !== points.length) {
    return [result(ruleId, definition, defaultSeverity, 'unknown', 'Road matching did not return a result for every trackpoint.', 'low', undefined, { expectedPoints: points.length, matchedResults: matches.length })]
  }
  const failures: RuleResult[] = []
  const uncertainties: RuleResult[] = []
  let evaluated = 0
  for (let i = 0; i < points.length; i++) {
    const match = matches[i]
    const point = points[i]
    if (match.status !== 'matched' || (match.confidence !== 'high' && match.confidence !== 'medium')) {
      uncertainties.push(result(
        ruleId, definition, defaultSeverity, 'unknown',
        match.reason ?? `Road match is ${match.status} with ${match.confidence} confidence.`,
        'low', point, { matchStatus: match.status, matchConfidence: match.confidence, candidates: match.candidates },
        { provider: match.provider ?? 'unknown' }
      ))
      continue
    }
    if (ruleId === 'contraflow_bike') {
      const tags = match.tags
      if (!tags || tags.oneway === undefined) {
        uncertainties.push(result(ruleId, definition, defaultSeverity, 'unknown', 'Required OSM oneway/bicycle tags are unavailable for this matched road.', 'low', point, undefined, { provider: match.provider, roadId: match.roadId }))
        continue
      }
      if (isOneWay(tags.oneway) && (match.direction === undefined || match.direction === 'unknown')) {
        uncertainties.push(result(ruleId, definition, defaultSeverity, 'unknown', 'The matched road direction is unavailable, so contraflow cannot be determined.', 'low', point, { roadId: match.roadId, oneway: tags.oneway }, { provider: match.provider }))
        continue
      }
      if (!isOneWay(tags.oneway) && !isTwoWay(tags.oneway)) {
        uncertainties.push(result(ruleId, definition, defaultSeverity, 'unknown', `OSM uses an unsupported oneway value "${tags.oneway}".`, 'low', point, { roadId: match.roadId, oneway: tags.oneway }, { provider: match.provider }))
        continue
      }
      evaluated++
      const againstDirection = tags.oneway === '-1'
        ? match.direction === 'forward'
        : isOneWay(tags.oneway) && match.direction === 'backward'
      const exception = hasBikeContraflow(tags)
      if (againstDirection && !exception) {
        failures.push(result(
          ruleId, definition, defaultSeverity, 'fail',
          `Route travels against one-way road "${match.roadName ?? match.roadId ?? 'unknown'}" without a bicycle contraflow exception.`,
          match.confidence, point,
          { roadId: match.roadId, oneway: tags.oneway, direction: match.direction, bicycle: tags.bicycle ?? null, cycleway: tags.cycleway ?? null },
          { provider: match.provider, tagSet: ['oneway', 'bicycle', 'cycleway'] }
        ))
      }
    } else {
      if (match.distanceToRoad === undefined || !Number.isFinite(match.distanceToRoad)) {
        uncertainties.push(result(ruleId, definition, defaultSeverity, 'unknown', 'Matched road distance is unavailable.', 'low', point, undefined, { provider: match.provider, roadId: match.roadId }))
        continue
      }
      evaluated++
      const threshold = numberParam(definition, 'max_distance_meters', 50)
      if (match.distanceToRoad > threshold) {
        failures.push(result(
          ruleId, definition, defaultSeverity, 'fail',
          `Trackpoint is ${match.distanceToRoad.toFixed(1)}m from the matched road, beyond the ${threshold}m limit.`,
          match.confidence, point, { roadId: match.roadId, distanceMeters: match.distanceToRoad, thresholdMeters: threshold },
          { provider: match.provider }
        ))
      }
    }
  }
  const out = [...failures, ...uncertainties]
  if (out.length === 0) out.push(result(
    ruleId, definition, defaultSeverity, evaluated > 0 ? 'pass' : 'unknown',
    evaluated > 0 ? (ruleId === 'contraflow_bike' ? 'No contraflow violations found on evaluated roads.' : 'All evaluated trackpoints are within the configured road distance.')
      : 'No sufficiently confident road matches were available.',
    evaluated > 0 ? 'high' : 'low', undefined, { evaluatedPoints: evaluated }, { provider: 'road-matching' }
  ))
  return out
}

function smoothElevations(points: Trackpoint[]): (number | null)[] {
  return points.map((point, index) => {
    if (point.ele === null) return null
    const previous = points[index - 1]
    const next = points[index + 1]
    const beforeElevation = previous?.segmentId === point.segmentId ? previous.ele ?? point.ele : point.ele
    const afterElevation = next?.segmentId === point.segmentId ? next.ele ?? point.ele : point.ele
    const window = [beforeElevation, point.ele, afterElevation].sort((a, b) => a - b)
    return window[1]
  })
}

function result(
  ruleId: string,
  definition: RuleDefinition,
  defaultSeverity: Severity,
  status: RuleResult['status'],
  message: string,
  confidence: Confidence,
  point?: Trackpoint,
  evidence?: Record<string, unknown>,
  source?: Record<string, unknown>
): RuleResult {
  const value: RuleResult = {
    ruleId,
    status,
    severity: definition.severity ?? defaultSeverity,
    confidence,
    message
  }
  if (point) {
    value.lat = point.lat
    value.lon = point.lon
  }
  if (evidence) value.evidence = evidence
  if (source) value.source = source
  return value
}

function numberParam(definition: RuleDefinition, name: string, fallback: number): number {
  const value = definition.params?.[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function sameSegment(a: Trackpoint, b: Trackpoint): boolean {
  return a.segmentId === b.segmentId
}

function hasBikeContraflow(tags: Record<string, string>): boolean {
  if (tags['oneway:bicycle'] === 'no' || ['yes', 'designated', 'opposite'].includes(tags.bicycle?.toLowerCase() ?? '')) return true
  return [tags.cycleway, tags['cycleway:left'], tags['cycleway:right']]
    .some(value => value !== undefined && ['opposite', 'opposite_lane', 'opposite_track'].includes(value.toLowerCase()))
}

function isOneWay(value: string | undefined): boolean {
  return value !== undefined && ['yes', '1', 'true', '-1'].includes(value.toLowerCase())
}

function isTwoWay(value: string | undefined): boolean {
  return value !== undefined && ['no', '0', 'false'].includes(value.toLowerCase())
}

function isFeatureCollection(value: unknown): value is GeoJsonFeatureCollection {
  return isGeoJsonFeatureCollection(value)
}
