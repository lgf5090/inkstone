import { MEMO_MAP_TILE_URL, NOMINATIM_REVERSE_ENDPOINT } from '@shared/memos/map-endpoints'

/**
 * The provider hosts a reader's browser may call directly.
 *
 * AI requests are deliberately not proxied through this Worker: the key stays in the reader's own
 * browser, so it never lands in a backup or on a device they did not type it into, and the request
 * goes from the browser to the provider. That privacy design requires `connect-src` to name the
 * provider, because a browser blocked from it silently loses the feature.
 *
 * These are the hosts the built-in provider presets ship — see the `PROVIDER_INFO` table in the
 * settings screens and the presets the RSS reader and the Excalidraw store default to. A host a
 * reader types by hand is not in this list and no deployment could predict one: a free-text
 * `openai-compatible` base URL is exactly what the reader is invited to enter, so such a reader is
 * blocked until their deployment names the host in `AI_CONNECT_HOSTS`. That is the deliberate limit
 * of keeping the key on the client — the escape valve is the variable, not a change to the policy.
 */
const BUILTIN_AI_CONNECT_HOSTS: readonly string[] = [
  'api.deepseek.com',
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
]

/**
 * The two hosts Cloudflare's Web Analytics beacon needs.
 *
 * A zone that has the beacon switched on gets the `<script>` appended to every HTML response by
 * Cloudflare's own edge, so this deployment never chose to load it. Refusing it is not a neutral act
 * either: the element fires a load error on every document — the exact shape `public/boot.js` has to
 * stay clear of, because a script failure is what a replaced build looks like — and no page view is
 * ever recorded. The script comes from `static.cloudflareinsights.com`; it reports to the same-origin
 * `/cdn-cgi/rum` the edge answers, or to `cloudflareinsights.com` when the injected config carries no
 * version of its own, so both are named.
 */
const CLOUDFLARE_INSIGHTS_SCRIPT_SOURCE = 'https://static.cloudflareinsights.com'
const CLOUDFLARE_INSIGHTS_REPORT_SOURCE = 'https://cloudflareinsights.com'
const MEMO_MAP_TILE_SOURCE = new URL(MEMO_MAP_TILE_URL).origin
const MEMO_MAP_GEOCODE_SOURCE = new URL(NOMINATIM_REVERSE_ENDPOINT).origin

export interface SecurityHeaderOptions {
  // Vite's dev server injects the React Fast Refresh bootstrap as an inline script,
  // which our own `script-src` refuses — and without that bootstrap the SPA
  // never mounts, so nobody can use `npm run dev`. Only a dev build serving an HTML
  // document may set this; the contract test pins the gate.
  allowDevInlineScripts?: boolean
  // The raw `AI_CONNECT_HOSTS` value, handed in by the caller so this module keeps not knowing
  // about `Env`. Malformed entries are dropped; a blank value keeps the built-in presets.
  aiConnectHosts?: string
}
export function securityHeaders(url: string, options: SecurityHeaderOptions = {}): Record<string, string> {
  const isHttps = new URL(url).protocol === 'https:'
  const imageSchemes = isHttps ? 'https:' : 'https: http:'
  const scriptSrc = `script-src 'self' ${CLOUDFLARE_INSIGHTS_SCRIPT_SOURCE}${options.allowDevInlineScripts ? " 'unsafe-inline'" : ''}; `
  const aiConnectSources = resolveAiConnectHosts(options.aiConnectHosts)
    .map((host) => `https://${host}`)
    .join(' ')
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // The assistant's dictation and voice mode need the reader's microphone; the page itself is the
    // only frame allowed to ask for it. Camera and location remain shut.
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()',
    'Content-Security-Policy': [
      `default-src 'self'; base-uri 'self'; ${scriptSrc}style-src 'self' 'unsafe-inline'; `,
      `img-src 'self' data: blob: ${imageSchemes} ${MEMO_MAP_TILE_SOURCE}; font-src 'self' data: https://esm.sh; connect-src 'self' data: blob: ${CLOUDFLARE_INSIGHTS_REPORT_SOURCE} ${MEMO_MAP_GEOCODE_SOURCE} ${aiConnectSources}; worker-src 'self' blob:; `,
      "manifest-src 'self'; media-src 'self' blob:; form-action 'self'; frame-src 'none'; ",
      "frame-ancestors 'none'; object-src 'none'",
    ].join(''),
  }
  if (isHttps) headers['Strict-Transport-Security'] = 'max-age=31536000'
  return headers
}

/**
 * A bare host — no scheme, no path, no separator that could end the directive and start another.
 *
 * The URL parser is the validator: building `https://` + the entry and requiring the parser to hand
 * the same host back is what rules out the fragments a hand-written pattern forgets.
 */
function normalizeConnectHost(entry: string): string | null {
  try {
    const parsed = new URL(`https://${entry}`)
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return null
    if (parsed.host.toLowerCase() !== entry.toLowerCase()) return null
    return parsed.host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The presets plus whatever the deployment names, never the deployment list alone.
 *
 * Replacing rather than extending would let one optional variable silently block the readers who
 * picked a built-in provider — the same failure this list exists to prevent — and an entry that
 * parses as something other than a bare host is a mistyped variable, not a directive: it is dropped
 * and reported instead of being pasted into the policy.
 */
function resolveAiConnectHosts(raw: string | undefined): readonly string[] {
  const configured = raw?.split(',').map((entry) => entry.trim()).filter(Boolean)
  if (!configured?.length) return BUILTIN_AI_CONNECT_HOSTS
  const hosts: string[] = []
  const rejected: string[] = []
  for (const entry of configured) {
    const host = normalizeConnectHost(entry)
    if (!host) rejected.push(entry)
    else if (!BUILTIN_AI_CONNECT_HOSTS.includes(host) && !hosts.includes(host)) hosts.push(host)
  }
  if (rejected.length) {
    console.warn(`[inkstone] AI_CONNECT_HOSTS dropped entries that are not bare hosts: ${rejected.join(', ')}`)
  }
  return hosts.length ? [...BUILTIN_AI_CONNECT_HOSTS, ...hosts] : BUILTIN_AI_CONNECT_HOSTS
}

// The OAuth provider and the MCP handler answer their own responses, so the app
// middleware never sees them and the headers have to be applied at the edge.
export function withSecurityHeaders(
  response: Response,
  url: string,
  options: SecurityHeaderOptions = {},
): Response {
  // A 101 handshake response carries the socket, and `new Response()` only accepts 200-599,
  // so rebuilding it to add headers would throw and tear down the WebSocket upgrade.
  if (response.status < 200) return response
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(securityHeaders(url, options))) {
    if (!headers.has(name)) headers.set(name, value)
  }
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
