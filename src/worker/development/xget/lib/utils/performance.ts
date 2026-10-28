// Derived from Xget (AGPL-3.0-only) src/utils/performance.js, via mpages functions/_lib/development/xget, with Inkstone adaptations.
import { addSecurityHeaders } from './security'

export class PerformanceMonitor {
  private readonly startTime: number
  private readonly marks: Map<string, number>

  constructor() {
    this.startTime = Date.now()
    this.marks = new Map()
  }

  mark(name: string): void {
    if (this.marks.has(name)) {
      console.warn(`[xget] Duplicate performance mark: ${name}`)
    }
    this.marks.set(name, Date.now() - this.startTime)
  }

  getMetrics(): Record<string, number> {
    return Object.fromEntries(this.marks.entries())
  }
}

export function addPerformanceHeaders(response: Response, monitor: PerformanceMonitor): Response {
  const headers = new Headers(response.headers)
  headers.set('X-Performance-Metrics', JSON.stringify(monitor.getMetrics()))
  addSecurityHeaders(headers)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
