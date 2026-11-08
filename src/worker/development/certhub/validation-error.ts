import { ApiError } from '../../lib/errors'

const REASONS: Record<string, string> = {
  domains_required: 'At least one domain is required',
  domains_too_many: 'Too many domains for one certificate',
  domain_required: 'A domain name is required',
  domain_invalid: 'The domain name is not valid',
  domain_duplicate: 'The same domain appears twice',
  wildcard_ip_invalid: 'A wildcard cannot be an IP address',
  ip_requires_http01: 'An IP address requires the HTTP-01 challenge',
  wildcard_requires_dns01: 'A wildcard requires the DNS-01 challenge',
  primary_ambiguous: 'Exactly one domain must be primary',
}

export function certhubValidationApiError(error: unknown): ApiError | null {
  const reason = error instanceof Error ? error.message : ''
  if (!REASONS[reason]) return null
  return new ApiError(400, 'bad_request', REASONS[reason], { reason })
}
