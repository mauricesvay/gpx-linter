import type { Trackpoint } from '../src/types'
import { distanceMeters } from '../src/geo'

export function point(
  lat: number,
  lon: number,
  ele: number | null = 0,
  index = 0
): Trackpoint {
  const value: Trackpoint = {
    lat, lon, ele, time: null, index, distanceFromStart: 0, bearing: null, segmentId: 0,
    distanceTo: other => distanceMeters(value, other)
  }
  return value
}
