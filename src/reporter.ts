import type {
  CacheStats,
  DataAvailability,
  LintReport,
  RuleResult
} from './types'

export function createReport(input: {
  routeName: string
  results: RuleResult[]
  availability: DataAvailability
  cache: CacheStats
}): LintReport {
  const availability: DataAvailability = {
    ...input.availability,
    incomplete: input.availability.incomplete || input.results.some(result => result.status === 'unknown')
  }
  const summary = {
    severity: { error: 0, warning: 0, info: 0 },
    status: { pass: 0, fail: 0, unknown: 0, skipped: 0 }
  }
  const rules: LintReport['rules'] = {}
  for (const item of input.results) {
    summary.status[item.status]++
    if (item.status === 'fail') summary.severity[item.severity]++
    const rule = rules[item.ruleId] ?? { failures: 0, unknown: 0, skipped: 0 }
    if (item.status === 'fail') rule.failures++
    if (item.status === 'unknown') rule.unknown++
    if (item.status === 'skipped') rule.skipped++
    rules[item.ruleId] = rule
  }
  const exitCode = availability.incomplete
    ? 2
    : summary.severity.error > 0
      ? 1
      : 0
  return {
    routeName: input.routeName,
    generatedAt: new Date().toISOString(),
    summary,
    rules,
    results: input.results,
    availability,
    cache: input.cache,
    exitCode
  }
}

export function formatReport(
  report: LintReport,
  format: 'text' | 'json' | 'html' = 'text',
  color: 'auto' | 'always' | 'never' = 'auto'
): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`
  if (format === 'html') return formatHtml(report)
  return formatText(report, color)
}

function formatText(report: LintReport, color: 'auto' | 'always' | 'never'): string {
  const useColor = color === 'always' || color === 'auto' && Boolean(process.stdout.isTTY)
  const paint = (value: string, code: number): string => useColor ? `\u001b[${code}m${value}\u001b[0m` : value
  const lines = [
    `GPX route report: ${report.routeName}`,
    `Result: ${report.summary.severity.error} error(s), ${report.summary.severity.warning} warning(s), ${report.summary.severity.info} info failure(s)`,
    `Outcomes: ${report.summary.status.pass} pass, ${report.summary.status.fail} fail, ${report.summary.status.unknown} unknown, ${report.summary.status.skipped} skipped`,
    `Cache: ${report.cache.hits} hit(s), ${report.cache.misses} miss(es)`,
    `Data complete: ${report.availability.incomplete ? 'no' : 'yes'}`
  ]
  for (const [source, availability] of Object.entries(report.availability)) {
    if (source === 'incomplete') continue
    lines.push(`  ${source}: ${availability.status} (${availability.availableItems}/${availability.requestedItems})${availability.message ? ` — ${availability.message}` : ''}`)
  }
  if (report.results.length > 0) {
    lines.push('', 'Findings:')
    for (const item of report.results) {
      const position = item.lat === undefined || item.lon === undefined
        ? ''
        : ` [${item.lat.toFixed(6)}, ${item.lon.toFixed(6)}]`
      const source = item.source ? ` (${Object.entries(item.source).map(([key, value]) => `${key}=${String(value)}`).join(', ')})` : ''
      const statusCode = item.status === 'fail' ? 31 : item.status === 'unknown' ? 33 : item.status === 'pass' ? 32 : 90
      const severityCode = item.severity === 'error' ? 31 : item.severity === 'warning' ? 33 : 36
      lines.push(`  ${paint(item.status.toUpperCase(), statusCode)} ${paint(item.severity.toUpperCase(), severityCode)} ${item.ruleId}${position}: ${item.message}${source}`)
    }
  }
  lines.push(`Exit code: ${report.exitCode}`)
  return `${lines.join('\n')}\n`
}

function formatHtml(report: LintReport): string {
  const findings = report.results.map(item => `<li class="${escapeHtml(item.status)}"><strong>${escapeHtml(item.status.toUpperCase())} ${escapeHtml(item.severity.toUpperCase())} ${escapeHtml(item.ruleId)}</strong>: ${escapeHtml(item.message)}${item.lat === undefined ? '' : ` <span>(${item.lat.toFixed(6)}, ${item.lon?.toFixed(6)})</span>`}</li>`).join('\n')
  const statuses = Object.entries(report.availability)
    .filter(([key]) => key !== 'incomplete')
    .map(([key, item]) => `<li>${escapeHtml(key)}: ${escapeHtml(item.status)} (${item.availableItems}/${item.requestedItems})${item.message ? ` — ${escapeHtml(item.message)}` : ''}</li>`)
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GPX report — ${escapeHtml(report.routeName)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#202124}li{margin:.55rem 0}.fail{color:#a12020}.unknown{color:#765900}.pass{color:#176b37}.skipped{color:#555}</style></head>
<body><h1>GPX route report: ${escapeHtml(report.routeName)}</h1>
<p>${report.summary.severity.error} error(s), ${report.summary.severity.warning} warning(s), ${report.summary.severity.info} info failure(s)</p>
<h2>Data availability</h2><ul>${statuses}</ul>
<h2>Findings</h2><ul>${findings}</ul><p>Exit code: ${report.exitCode}</p></body></html>
`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!)
}
