// @vitest-environment node
/**
 * The audit trail's line for a failure.
 *
 * The trail is read months later by someone asking "which call failed, and with what", so the code has
 * to survive and the sentence has to stay short: an upstream body pasted whole is neither a log row nor
 * a query key. The reader still gets the full sentence from the API answer, not from here.
 */
import { describe, expect, it } from 'vitest'
import { auditFailureDetail } from '../src/worker/cloudflare/audit'
import { CloudflareApiError, upstreamApiError } from '../src/worker/cloudflare/cf-api'
import { ApiError } from '../src/worker/lib/errors'

function cfError(message: string, cfCode?: number): ApiError {
  const body = JSON.stringify({ success: false, errors: [{ code: cfCode, message }] })
  return upstreamApiError(new CloudflareApiError({ status: 400, body, cfCode }))
}

describe('the audit line for a failure', () => {
  it('keeps Cloudflare’s own code beside the module’s code', () => {
    expect(auditFailureDetail(cfError('Authentication error', 10000)))
      .toBe('cloudflare_upstream cf=10000: Authentication error')
    expect(auditFailureDetail(cfError('No code on this one')))
      .toBe('cloudflare_upstream: No code on this one')
  })

  it('keeps a route refusal under its own code', () => {
    expect(auditFailureDetail(ApiError.badRequest('A readme URL is required')))
      .toBe('bad_request: A readme URL is required')
  })

  it('bounds the sentence and flattens it, so one failure stays one row', () => {
    const long = auditFailureDetail(cfError(`${'x'.repeat(40)}\n\n${'y'.repeat(400)}`, 7003))
    expect(long.startsWith('cloudflare_upstream cf=7003: x')).toBe(true)
    expect(long.length).toBe('cloudflare_upstream cf=7003: '.length + 120)
    expect(long).not.toContain('\n')
  })
})
