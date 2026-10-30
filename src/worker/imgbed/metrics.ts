export type ImgbedMetricLevel = 'info' | 'warn' | 'error'

type ImgbedMetricValue = string | number | boolean | undefined

function redact(value: string): string {
  return value
    .replace(/([?&](?:key|token|api_key|access_token|sig|signature)=)[^&\s]*/gi, '$1***')
    .replace(/\/bot[^/\s]*/g, '/bot***')
    .replace(/(Bearer\s+)\S+/gi, '$1***')
    .slice(0, 500)
}

export function imgbedMetric(level: ImgbedMetricLevel, event: string, fields: Record<string, ImgbedMetricValue> = {}): void {
  const payload: Record<string, string | number | boolean> = { source: 'imgbed', event }
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    payload[key] = typeof value === 'string' ? redact(value) : value
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}
