import { readFile } from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import type { LinterConfig, RuleDefinition, Severity } from './types'

const NUMERIC_RULE_PARAMS: Record<string, string[]> = {
  max_slope: ['max_percent', 'min_segment_meters', 'min_elevation_delta_meters'],
  roadworks: ['buffer_meters'],
  sharp_turn: ['max_angle', 'min_segment_meters', 'min_heading_change_degrees'],
  off_road: ['max_distance_meters'],
  missing_elevation: ['max_missing_percent'],
  route_gaps: ['max_gap_meters'],
  loop_closure: ['max_return_distance_meters']
}

export const DEFAULT_CONFIG: LinterConfig = {
  rules: {
    max_slope: { enabled: true, severity: 'error', params: { max_percent: 10 } },
    contraflow_bike: { enabled: true, severity: 'error' },
    roadworks: { enabled: false, severity: 'warning', params: { buffer_meters: 5 } },
    sharp_turn: { enabled: true, severity: 'warning', params: { max_angle: 60, min_segment_meters: 5 } },
    off_road: { enabled: false, severity: 'error', params: { max_distance_meters: 50 } },
    missing_elevation: { enabled: true, severity: 'info', params: { max_missing_percent: 20 } },
    route_gaps: { enabled: true, severity: 'info', params: { max_gap_meters: 500 } },
    loop_closure: { enabled: true, severity: 'info', params: { max_return_distance_meters: 100 } }
  },
  routing: {
    provider: 'osrm',
    fallback: 'graphhopper',
    graphhopper_url: 'http://localhost:8989',
    osrm_url: 'https://router.project-osrm.org',
    batch_size: 50,
    cache: true
  },
  reporting: { format: 'text', color: 'auto' },
  route_context: { loop_expected: false, ferry_allowed: false }
}

export async function loadConfig(configPath?: string): Promise<LinterConfig> {
  if (!configPath) return structuredClone(DEFAULT_CONFIG)
  let contents: string
  try {
    contents = await readFile(configPath, 'utf8')
  } catch (error) {
    throw new Error(`Unable to read config file "${configPath}": ${errorMessage(error)}`)
  }

  let parsed: unknown
  try {
    parsed = yaml.load(contents)
  } catch (error) {
    throw new Error(`Invalid YAML in config file "${configPath}": ${errorMessage(error)}`)
  }
  if (!isRecord(parsed)) throw new Error('Configuration must be a YAML mapping')
  const config = structuredClone(DEFAULT_CONFIG)

  if (parsed.rules !== undefined) {
    if (!isRecord(parsed.rules)) throw new Error('"rules" must be a mapping')
    for (const [id, rawDefinition] of Object.entries(parsed.rules)) {
      if (!isRecord(rawDefinition)) throw new Error(`Rule "${id}" must be a mapping`)
      if (rawDefinition.enabled !== undefined && typeof rawDefinition.enabled !== 'boolean') {
        throw new Error(`Rule "${id}" enabled must be a boolean`)
      }
      if (rawDefinition.severity !== undefined && !isSeverity(rawDefinition.severity)) {
        throw new Error(`Rule "${id}" severity must be error, warning, or info`)
      }
      if (rawDefinition.description !== undefined && typeof rawDefinition.description !== 'string') {
        throw new Error(`Rule "${id}" description must be a string`)
      }
      if (rawDefinition.params !== undefined && !isRecord(rawDefinition.params)) {
        throw new Error(`Rule "${id}" params must be a mapping`)
      }
      const definition: RuleDefinition = {
        enabled: typeof rawDefinition.enabled === 'boolean' ? rawDefinition.enabled : undefined,
        severity: isSeverity(rawDefinition.severity) ? rawDefinition.severity : undefined,
        description: typeof rawDefinition.description === 'string' ? rawDefinition.description : undefined,
        params: recordOrEmpty(rawDefinition.params),
        data: rawDefinition.data
      }
      const base = config.rules[id] ?? { enabled: true }
      config.rules[id] = {
        ...base,
        ...definition,
        params: { ...base.params, ...recordOrEmpty(definition.params) }
      }
      if (typeof definition.params?.geojson_file === 'string') {
        config.rules[id].params = {
          ...config.rules[id].params,
          geojson_file: path.resolve(path.dirname(path.resolve(configPath)), definition.params.geojson_file)
        }
      }
    }
  }

  if (parsed.routing !== undefined) {
    if (!isRecord(parsed.routing)) throw new Error('"routing" must be a mapping')
    config.routing = mergeRouting(config.routing, parsed.routing)
    if (parsed.routing.provider !== undefined && parsed.routing.fallback === undefined
      && config.routing?.fallback === config.routing?.provider) {
      config.routing = {
        ...config.routing,
        fallback: config.routing?.provider === 'osrm' ? 'graphhopper' : 'osrm'
      }
    }
  }
  if (parsed.reporting !== undefined) {
    if (!isRecord(parsed.reporting)) throw new Error('"reporting" must be a mapping')
    config.reporting = mergeReporting(config.reporting, parsed.reporting)
  }
  if (parsed.route_context !== undefined) {
    if (!isRecord(parsed.route_context)) throw new Error('"route_context" must be a mapping')
    config.route_context = mergeRouteContext(config.route_context, parsed.route_context)
  }
  validateConfig(config)
  return config
}

export function applyRuleOverride(
  config: LinterConfig,
  ruleId: string,
  enabled: boolean
): LinterConfig {
  if (!config.rules[ruleId]) throw new Error(`Unknown rule "${ruleId}"`)
  return {
    ...config,
    rules: { ...config.rules, [ruleId]: { ...config.rules[ruleId], enabled } }
  }
}

function validateConfig(config: LinterConfig): void {
  const format = config.reporting?.format
  if (format !== undefined && !['text', 'json', 'html'].includes(format)) {
    throw new Error('"reporting.format" must be text, json, or html')
  }
  const color = config.reporting?.color
  if (color !== undefined && !['auto', 'always', 'never'].includes(color)) {
    throw new Error('"reporting.color" must be auto, always, or never')
  }
  const provider = config.routing?.provider
  if (provider !== undefined && !['osrm', 'graphhopper', 'offline'].includes(provider)) {
    throw new Error('"routing.provider" must be osrm, graphhopper, or offline')
  }
  const fallback = config.routing?.fallback
  if (fallback !== undefined && !['osrm', 'graphhopper'].includes(fallback)) {
    throw new Error('"routing.fallback" must be osrm or graphhopper')
  }
  if (provider !== undefined && fallback === provider) {
    throw new Error('"routing.fallback" must differ from routing.provider')
  }
  const batchSize = config.routing?.batch_size
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)) {
    throw new Error('"routing.batch_size" must be an integer between 1 and 100')
  }
  if (config.routing?.cache !== undefined && typeof config.routing.cache !== 'boolean') {
    throw new Error('"routing.cache" must be a boolean')
  }
  for (const key of ['url', 'osrm_url', 'graphhopper_url', 'overpass_url'] as const) {
    const value = config.routing?.[key]
    if (value !== undefined) {
      if (typeof value !== 'string') throw new Error(`"routing.${key}" must be a URL`)
      try {
        const url = new URL(value)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error()
      } catch {
        throw new Error(`"routing.${key}" must be a valid HTTP(S) URL`)
      }
    }
  }
  for (const key of ['loop_expected', 'ferry_allowed', 'ignore_dead_end'] as const) {
    const value = config.route_context?.[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`"route_context.${key}" must be a boolean`)
    }
  }
  for (const [id, rule] of Object.entries(config.rules)) {
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') {
      throw new Error(`Rule "${id}" enabled must be a boolean`)
    }
    if (rule.severity !== undefined && !isSeverity(rule.severity)) {
      throw new Error(`Rule "${id}" severity must be error, warning, or info`)
    }
    for (const key of NUMERIC_RULE_PARAMS[id] ?? []) {
      const value = rule.params?.[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error(`Rule "${id}" parameter "${key}" must be a non-negative number`)
      }
    }
    if (id === 'max_slope' && typeof rule.params?.max_percent === 'number' && rule.params.max_percent <= 0) {
      throw new Error('Rule "max_slope" parameter "max_percent" must be greater than zero')
    }
    if (id === 'sharp_turn' && typeof rule.params?.max_angle === 'number' && rule.params.max_angle > 180) {
      throw new Error('Rule "sharp_turn" parameter "max_angle" must not exceed 180 degrees')
    }
    if (id === 'missing_elevation' && typeof rule.params?.max_missing_percent === 'number' && rule.params.max_missing_percent > 100) {
      throw new Error('Rule "missing_elevation" parameter "max_missing_percent" must not exceed 100')
    }
    if (id === 'roadworks' && rule.params?.geojson_file !== undefined && typeof rule.params.geojson_file !== 'string') {
      throw new Error('Rule "roadworks" parameter "geojson_file" must be a string')
    }
  }
}

function isSeverity(value: unknown): value is Severity {
  return value === 'error' || value === 'warning' || value === 'info'
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeRouting(
  base: LinterConfig['routing'],
  raw: Record<string, unknown>
): LinterConfig['routing'] {
  const result = { ...base }
  if (raw.provider !== undefined) {
    if (!isRoutingProvider(raw.provider)) throw new Error('"routing.provider" must be osrm, graphhopper, or offline')
    result.provider = raw.provider
  }
  if (raw.fallback !== undefined) {
    if (raw.fallback !== 'osrm' && raw.fallback !== 'graphhopper') {
      throw new Error('"routing.fallback" must be osrm or graphhopper')
    }
    result.fallback = raw.fallback
  }
  for (const key of ['url', 'graphhopper_url', 'osrm_url', 'overpass_url', 'cache_dir'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string') throw new Error(`"routing.${key}" must be a string`)
      result[key] = raw[key]
    }
  }
  if (raw.batch_size !== undefined) {
    if (typeof raw.batch_size !== 'number') throw new Error('"routing.batch_size" must be a number')
    result.batch_size = raw.batch_size
  }
  if (raw.cache !== undefined) {
    if (typeof raw.cache !== 'boolean') throw new Error('"routing.cache" must be a boolean')
    result.cache = raw.cache
  }
  return result
}

function mergeReporting(
  base: LinterConfig['reporting'],
  raw: Record<string, unknown>
): LinterConfig['reporting'] {
  const result = { ...base }
  if (raw.format !== undefined) {
    if (raw.format !== 'text' && raw.format !== 'json' && raw.format !== 'html') {
      throw new Error('"reporting.format" must be text, json, or html')
    }
    result.format = raw.format
  }
  if (raw.color !== undefined) {
    if (raw.color !== 'auto' && raw.color !== 'always' && raw.color !== 'never') {
      throw new Error('"reporting.color" must be auto, always, or never')
    }
    result.color = raw.color
  }
  return result
}

function mergeRouteContext(
  base: LinterConfig['route_context'],
  raw: Record<string, unknown>
): LinterConfig['route_context'] {
  const result = { ...base }
  for (const key of ['route_type', 'terrain', 'bike_type', 'expected_access'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string') throw new Error(`"route_context.${key}" must be a string`)
      result[key] = raw[key]
    }
  }
  for (const key of ['loop_expected', 'ferry_allowed', 'ignore_dead_end'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') throw new Error(`"route_context.${key}" must be a boolean`)
      result[key] = raw[key]
    }
  }
  return result
}

function isRoutingProvider(value: unknown): value is 'osrm' | 'graphhopper' | 'offline' {
  return value === 'osrm' || value === 'graphhopper' || value === 'offline'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
