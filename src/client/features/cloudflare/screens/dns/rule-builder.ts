/**
 * The rule form's pure half: what the fields mean, and what they become.
 *
 * A Cloudflare rule is an expression in their filter language plus an action object whose shape depends
 * on the phase the rule lives in. The reference module asked a reader to type both by hand; these
 * functions turn five match kinds and the per-phase fields into the same pair, and read a stored rule
 * back into the fields so an edit starts from what the rule already says.
 */
import type { DnsRule, RulePhase } from '../../api/dns'

export type RuleMatchType = 'hostname' | 'pathPrefix' | 'pathRegex' | 'hostAndPath' | 'custom'

export type RuleHeaderOp = 'set' | 'add' | 'remove'

export type RuleTtlMode = 'respect_origin' | 'custom'

export interface RuleFormState {
  matchType: RuleMatchType
  /** The part left of the zone name; empty is the apex. */
  subdomain: string
  path: string
  /** Used only by the `custom` match kind. */
  expression: string
  port: number
  redirectUrl: string
  redirectStatus: number
  rewriteTarget: 'path' | 'query'
  rewriteValue: string
  headerOp: RuleHeaderOp
  headerName: string
  headerValue: string
  cacheEnabled: boolean
  ttlMode: RuleTtlMode
  ttlSeconds: number
  limitAction: 'block' | 'managed_challenge' | 'js_challenge' | 'challenge'
  limitPeriod: number
  limitRequests: number
  limitMitigation: number
}

export interface RulePayload {
  expression: string
  action: string
  action_parameters: Record<string, unknown>
}

const DEFAULT_PORT = 80
const DEFAULT_TTL = 3600
const DEFAULT_PERIOD = 60
const DEFAULT_REQUESTS = 100
const DEFAULT_MITIGATION = 60

export function emptyRuleForm(): RuleFormState {
  return {
    matchType: 'hostname',
    subdomain: '',
    path: '',
    expression: '',
    port: DEFAULT_PORT,
    redirectUrl: '',
    redirectStatus: 301,
    rewriteTarget: 'path',
    rewriteValue: '',
    headerOp: 'set',
    headerName: '',
    headerValue: '',
    cacheEnabled: true,
    ttlMode: 'respect_origin',
    ttlSeconds: DEFAULT_TTL,
    limitAction: 'block',
    limitPeriod: DEFAULT_PERIOD,
    limitRequests: DEFAULT_REQUESTS,
    limitMitigation: DEFAULT_MITIGATION,
  }
}

/** A literal path becomes a prefix regex: `.` and friends must not widen the match. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unescapeRegex(pattern: string): string {
  return pattern.replace(/\\(.)/g, '$1')
}

/** The host the rule matches: the subdomain joined to the zone, or the zone itself at the apex. */
export function matchHost(form: Pick<RuleFormState, 'subdomain'>, zoneName: string): string {
  const subdomain = form.subdomain.trim().replace(/\.$/, '')
  return subdomain ? `${subdomain}.${zoneName}` : zoneName
}

/** The filter expression the match fields describe; empty when the form cannot say anything yet. */
export function buildExpression(form: RuleFormState, zoneName: string): string {
  const host = matchHost(form, zoneName)
  const path = form.path.trim()
  switch (form.matchType) {
    case 'hostname':
      return host ? `(http.host eq "${host}")` : ''
    case 'pathPrefix':
      return path ? `(http.request.uri.path matches "^${escapeRegex(path)}.*")` : ''
    case 'pathRegex':
      return path ? `(http.request.uri.path matches "${path}")` : ''
    case 'hostAndPath':
      return host && path
        ? `(http.host eq "${host}" and http.request.uri.path matches "^${escapeRegex(path)}.*")`
        : ''
    default:
      return form.expression.trim()
  }
}

/**
 * The action half, as the phase expects it.
 *
 * A phase fixes the action unless it offers a set (firewall and rate limiting do), which is why the
 * caller passes the chosen one in rather than having this invent it.
 */
export function buildAction(phase: RulePhase, form: RuleFormState): Record<string, unknown> {
  switch (phase) {
    case 'origin':
      return { origin: { port: form.port } }
    case 'redirect':
      return {
        from_value: {
          target: { url: form.redirectUrl.trim() },
          status_code: form.redirectStatus,
        },
      }
    case 'transform':
      return { uri: { [form.rewriteTarget]: { expression: form.rewriteValue } } }
    case 'request_headers':
    case 'response_headers': {
      const scope = phase === 'request_headers' ? 'request' : 'response'
      const name = form.headerName.trim()
      if (form.headerOp === 'remove') return { headers: { [scope]: { remove: [name] } } }
      return { headers: { [scope]: { [form.headerOp]: { [name]: form.headerValue } } } }
    }
    case 'cache_settings':
      return {
        cache: form.cacheEnabled,
        edge_ttl: form.ttlMode === 'custom'
          ? { mode: 'override', value: form.ttlSeconds }
          : { mode: 'respect_origin_ttl' },
      }
    case 'rate_limit':
      return {
        characteristics: ['ip'],
        period: form.limitPeriod,
        requests_per_period: form.limitRequests,
        mitigation_timeout: form.limitMitigation,
      }
    default:
      return {}
  }
}

/** What the dialog sends: the expression, the action and the parameters that go with it. */
export function buildPayload(
  phase: RulePhase,
  form: RuleFormState,
  zoneName: string,
  action: string,
): RulePayload | null {
  const expression = buildExpression(form, zoneName)
  if (!expression) return null
  return { expression, action, action_parameters: buildAction(phase, form) }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

/**
 * Read a stored rule back into the form, so an edit starts from the rule's own words.
 *
 * An expression that none of the five shapes describe keeps itself: the form switches to `custom` and
 * carries the expression verbatim, which is the only honest way to edit something the fields cannot
 * express.
 */
export function formFromRule(rule: DnsRule, phase: RulePhase, zoneName: string): RuleFormState {
  const form = emptyRuleForm()
  const expression = (rule.expression ?? '').trim()
  form.expression = expression

  const hostMatch = /^\(http\.host eq "([^"]+)"\)$/.exec(expression)
  const prefixMatch = /^\(http\.request\.uri\.path matches "\^(.+)\.\*"\)$/.exec(expression)
  const bothMatch = /^\(http\.host eq "([^"]+)" and http\.request\.uri\.path matches "\^(.+)\.\*"\)$/.exec(expression)
  const regexMatch = /^\(http\.request\.uri\.path matches "(.+)"\)$/.exec(expression)

  const setHost = (host: string): void => {
    if (host === zoneName) return
    if (host.endsWith(`.${zoneName}`)) form.subdomain = host.slice(0, -(zoneName.length + 1))
  }

  if (bothMatch) {
    form.matchType = 'hostAndPath'
    setHost(bothMatch[1] ?? '')
    form.path = unescapeRegex(bothMatch[2] ?? '')
  } else if (hostMatch) {
    form.matchType = 'hostname'
    setHost(hostMatch[1] ?? '')
  } else if (prefixMatch) {
    form.matchType = 'pathPrefix'
    form.path = unescapeRegex(prefixMatch[1] ?? '')
  } else if (regexMatch) {
    form.matchType = 'pathRegex'
    form.path = regexMatch[1] ?? ''
  } else {
    form.matchType = 'custom'
  }

  const parameters = objectOf(rule.action_parameters)
  switch (phase) {
    case 'origin': {
      form.port = numberOf(objectOf(parameters.origin).port, DEFAULT_PORT)
      break
    }
    case 'redirect': {
      const from = objectOf(parameters.from_value)
      form.redirectUrl = stringOf(objectOf(from.target).url)
      form.redirectStatus = numberOf(from.status_code, 301)
      break
    }
    case 'transform': {
      const uri = objectOf(parameters.uri)
      form.rewriteTarget = 'query' in uri ? 'query' : 'path'
      form.rewriteValue = stringOf(objectOf(uri[form.rewriteTarget]).expression)
      break
    }
    case 'request_headers':
    case 'response_headers': {
      const headers = objectOf(objectOf(parameters.headers)[phase === 'request_headers' ? 'request' : 'response'])
      if (Array.isArray(headers.remove) && headers.remove.length > 0) {
        form.headerOp = 'remove'
        form.headerName = stringOf(headers.remove[0])
        break
      }
      const op: RuleHeaderOp = 'add' in headers ? 'add' : 'set'
      const entry = objectOf(headers[op])
      const name = Object.keys(entry)[0] ?? ''
      form.headerOp = op
      form.headerName = name
      form.headerValue = stringOf(entry[name])
      break
    }
    case 'cache_settings': {
      form.cacheEnabled = parameters.cache !== false
      const ttl = objectOf(parameters.edge_ttl)
      form.ttlMode = ttl.mode === 'override' ? 'custom' : 'respect_origin'
      form.ttlSeconds = numberOf(ttl.value, DEFAULT_TTL)
      break
    }
    case 'rate_limit': {
      const chosen = rule.action
      if (chosen === 'block' || chosen === 'managed_challenge' || chosen === 'js_challenge' || chosen === 'challenge') {
        form.limitAction = chosen
      }
      form.limitPeriod = numberOf(parameters.period, DEFAULT_PERIOD)
      form.limitRequests = numberOf(parameters.requests_per_period, DEFAULT_REQUESTS)
      form.limitMitigation = numberOf(parameters.mitigation_timeout, DEFAULT_MITIGATION)
      break
    }
    default:
      break
  }
  return form
}
