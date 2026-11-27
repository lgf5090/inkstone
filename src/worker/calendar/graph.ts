import type { Env } from '../env'
import { ApiError } from '../lib/errors'

export const DEFAULT_OUTLOOK_GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0/'

function configError(message: string): ApiError {
  return new ApiError(503, 'server_misconfigured', message)
}

export function validateOutlookGraphBase(raw: unknown): string {
  if (typeof raw !== 'string') throw configError('OUTLOOK_GRAPH_API_BASE must be an https URL')
  const value = raw.trim()
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(value)) {
    throw configError('OUTLOOK_GRAPH_API_BASE must be an https URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw configError('OUTLOOK_GRAPH_API_BASE must be an https URL')
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw configError('OUTLOOK_GRAPH_API_BASE must use https on port 443 without credentials')
  }
  if (url.search || url.hash || /%25|%2e|%2f|%5c/i.test(value)) {
    throw configError('OUTLOOK_GRAPH_API_BASE may not carry a query, fragment or encoded path segments')
  }
  return url.toString()
}

export function outlookGraphBase(env: Pick<Env, 'OUTLOOK_GRAPH_API_BASE'>): string {
  return validateOutlookGraphBase(env.OUTLOOK_GRAPH_API_BASE?.trim() || DEFAULT_OUTLOOK_GRAPH_API_BASE)
}

export function assertOutlookGraphBase(
  env: Pick<Env, 'OUTLOOK_GRAPH_API_BASE'>,
  baseUrl: string,
  calendarHomeUrl: string | null,
): string {
  const expected = outlookGraphBase(env)
  if (baseUrl !== expected || calendarHomeUrl !== expected) {
    throw new ApiError(500, 'internal', 'This Outlook connection has an invalid Graph base address')
  }
  return expected
}
