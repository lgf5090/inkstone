/**
 * Being an OAuth client, on the reader's behalf, toward a third-party MCP server.
 *
 * The MCP authorization spec puts the burden on the client: a server that needs a login answers `401` and
 * names a metadata document, and everything after that — finding the authorization server, registering this
 * app as a client, sending the reader through their identity provider with PKCE, and trading the returned
 * code for a token — is the client's job. This module is that job, and only that: it holds no rows, makes
 * no policy decisions, and never returns a token to the browser.
 *
 * Two rules shape the code below.
 *
 * Every address here comes from a document written by somebody else, so every one of them is put through
 * the same https-and-not-inside-the-network test the MCP URL itself passed. An authorization server that
 * points its token endpoint at `169.254.169.254` is not a misconfiguration to be tolerated; it is the
 * reason the check exists.
 *
 * And nothing is invented when the server could have said it. The scopes are the ones the resource named,
 * the endpoints are the ones the metadata carried, and the client id is the one the registration endpoint
 * handed back — because an assistant that guesses an OAuth shape will guess the wrong one quietly.
 */

import { toBase64Url, timingSafeEqual } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { NO_REDIRECT } from '../lib/no-redirect'
import { mcpUrlProblem } from './mcp-client'
import type { AssistantStore } from './store'

/** How long a reader may take to come back from their identity provider with the code. */
export const PENDING_AUTH_LIVES_MS = 10 * 60 * 1000

/** Refresh this early, so a turn never starts with a token that dies mid-answer. */
const EXPIRY_MARGIN_MS = 60 * 1000

const MAX_METADATA_BYTES = 64 * 1024

export interface McpOAuthEndpoints {
  /** The authorization server the resource metadata named. */
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  /** Empty when the server has no dynamic registration; the reader then has to name a client themselves. */
  registrationEndpoint: string
  /** The scopes the resource asked for. An empty list is sent as an empty scope, not as a guess. */
  scopes: string[]
}

/** What this app became at that server: an id and, when the issuer insists, a secret. */
export interface McpOAuthClient {
  clientId: string
  clientSecret: string
}

/**
 * Where the issuer says this app may be withdrawn, and the token good for that one act (RFC 7592).
 *
 * Handed back by the registration endpoint and stored in the vault, never in the plain column: the access
 * token here deletes the client, so it is as much a credential as the client secret is.
 */
export interface McpOAuthRegistration {
  clientUri: string
  accessToken: string
}

/** The client a registration call produced, together with the means to undo it — null when the issuer gave none. */
export interface McpOAuthRegistrationResult {
  client: McpOAuthClient
  registration: McpOAuthRegistration | null
}

export interface McpOAuthTokens {
  access: string
  refresh: string
  /** Epoch millis when the access token stops working; 0 when the server gave no expiry. */
  expiresAt: number
  tokenType: string
}

/** The secret half of one server's authorization, as it is kept in the vault. */
export interface McpOAuthSecrets extends McpOAuthClient {
  /** How to withdraw this client at the issuer, when the issuer allowed it. */
  registration: McpOAuthRegistration | null
  tokens: McpOAuthTokens | null
  /** The round trip the reader is still inside: the verifier that went out and the state to match. */
  pending: { verifier: string, state: string, startedAt: number } | null
}

/**
 * The plain half — everything the settings screen can show without touching the vault.
 *
 * `clientId` is here on purpose and `clientSecret` is not. A client id is handed out in a browser address
 * bar during every OAuth redirect and is public in the spec's own terms; the secret is the thing that must
 * not end up in a column a backup file can be read out of.
 */
export interface McpOAuthStatus extends McpOAuthEndpoints {
  clientId: string
  /** True when the id came from the issuer's registration endpoint, so it can be withdrawn there too. */
  dynamic: boolean
  authorized: boolean
  expiresAt: number
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * The platform's own fetch, wrapped.
 *
 * Handing round a bare `fetch` reference is an illegal invocation in workerd, and the three orchestration
 * functions below are called from routes and from the turn alike — so the wrapper is made once here rather
 * than at each place somebody remembered to write `fetch`.
 */
const fetchOAuth: FetchLike = (input, init) => fetch(input, { ...init, redirect: NO_REDIRECT })

/**
 * Read one JSON document the third party wrote about itself.
 *
 * Bounded and decoded here rather than at each call site because all three of these documents — the
 * resource's, the authorization server's, and the registration reply — arrive the same way: from a URL a
 * remote document named, carrying a body that is not ours to trust.
 */
async function readJsonDocument(fetchImpl: FetchLike, url: string, what: string): Promise<Record<string, unknown> | null> {
  const problem = mcpUrlProblem(url)
  if (problem) throw ApiError.badRequest(`${what}: ${problem}`)
  let response: Response
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch {
    return null
  }
  if (!response.ok) return null
  const text = (await response.text().catch(() => '')).slice(0, MAX_METADATA_BYTES)
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function stringList(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, max) : []
}

function endpointFrom(document: Record<string, unknown>, field: string, issuer: string, what: string): string {
  const value = document[field]
  if (typeof value !== 'string' || !value) throw ApiError.badRequest(`The authorization server named no ${what}.`)
  let url: URL
  try {
    url = new URL(value, issuer)
  } catch {
    throw ApiError.badRequest(`The authorization server named an unusable ${what}.`)
  }
  const problem = mcpUrlProblem(url.toString())
  if (problem) throw ApiError.badRequest(`${what}: ${problem}`)
  return url.toString()
}

/**
 * Where this MCP server sends its readers to log in.
 *
 * Two documents, in the order the spec lays them out. The resource's own metadata names the authorization
 * server and the scopes; the server's metadata names the endpoints. A server that answers 401 and publishes
 * neither is not unsupported silently — the caller gets the reason.
 */
export async function discoverMcpOAuth(fetchImpl: FetchLike, mcpUrl: string, resourceMetadataUrl?: string): Promise<McpOAuthEndpoints> {
  const base = new URL(mcpUrl)
  const path = base.pathname.replace(/\/+$/, '')
  const candidates = [
    ...(resourceMetadataUrl ? [resourceMetadataUrl] : []),
    // RFC 9728 puts the resource's own path inside the well-known name, so a server hosted at /a/mcp says
    // /.well-known/oauth-protected-resource/a/mcp; the plain origin form is what most servers publish.
    `${base.origin}/.well-known/oauth-protected-resource${path}`,
    `${base.origin}/.well-known/oauth-protected-resource`,
  ]
  let resource: Record<string, unknown> | null = null
  for (const url of candidates) {
    resource = await readJsonDocument(fetchImpl, url, 'The protected-resource metadata')
    if (resource) break
  }
  if (!resource) throw ApiError.badRequest('The server asks for a login but publishes no OAuth metadata, so there is nothing to authorize against.')
  const issuers = stringList(resource.authorization_servers, 4)
  if (!issuers.length) throw ApiError.badRequest('The server\u2019s OAuth metadata names no authorization server.')
  const issuer = issuers[0]!

  const issuerUrl = new URL(issuer)
  const documents = [
    `${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerUrl.pathname.replace(/\/+$/, '')}`,
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ]
  let server: Record<string, unknown> | null = null
  for (const url of documents) {
    server = await readJsonDocument(fetchImpl, url, 'The authorization-server metadata')
    if (server?.authorization_endpoint && server?.token_endpoint) break
  }
  if (!server) throw ApiError.badRequest('The authorization server publishes no metadata this client can read.')

  // PKCE is not optional here. The spec says a public client must use it, and this one keeps no secret
  // worth calling one, so a server that will not accept S256 is refused rather than downgraded to plain.
  const methods = stringList(server.code_challenge_methods_supported, 4)
  if (methods.length && !methods.includes('S256')) {
    throw ApiError.badRequest('The authorization server does not support PKCE, which this client will not work without.')
  }
  const registration = typeof server.registration_endpoint === 'string' && server.registration_endpoint
    ? endpointFrom(server, 'registration_endpoint', issuer, 'The registration endpoint')
    : ''
  return {
    issuer,
    authorizationEndpoint: endpointFrom(server, 'authorization_endpoint', issuer, 'The authorization endpoint'),
    tokenEndpoint: endpointFrom(server, 'token_endpoint', issuer, 'The token endpoint'),
    registrationEndpoint: registration,
    scopes: stringList(resource.scopes_supported, 16),
  }
}

/**
 * Ask the authorization server what this app's client id is.
 *
 * Dynamic registration is what lets a reader add a server they found on their own, with no app pre-registered
 * by anybody. A server without the endpoint can still be used — by a reader who pastes a client id they
 * obtained elsewhere — so the empty string is a request to use the stored one, not an error.
 */
export async function registerMcpOAuthClient(
  fetchImpl: FetchLike,
  endpoints: McpOAuthEndpoints,
  redirectUri: string,
  clientName: string,
  suppliedClientId: string,
): Promise<McpOAuthRegistrationResult> {
  if (!endpoints.registrationEndpoint) {
    if (!suppliedClientId) throw ApiError.badRequest('This authorization server does not register clients, so a client id has to be supplied.')
    // An id the reader typed is theirs, registered by hand with their provider; there is no registration
    // address here that could delete it, and pretending otherwise would offer a button that cannot work.
    return { client: { clientId: suppliedClientId, clientSecret: '' }, registration: null }
  }
  const response = await fetchImpl(endpoints.registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName.slice(0, 120),
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // This app is a public client in the only sense that matters: nothing it ships keeps a secret, since
      // every reader's deployment re-registers its own client at the server.
      token_endpoint_auth_method: 'none',
      scope: endpoints.scopes.join(' '),
    }),
  })
  const text = (await response.text().catch(() => '')).slice(0, MAX_METADATA_BYTES)
  let parsed: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(text)
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    parsed = null
  }
  if (!response.ok || typeof parsed?.client_id !== 'string' || !parsed.client_id) {
    throw ApiError.badRequest(`The authorization server refused to register this app (HTTP ${response.status}).`)
  }
  // The two RFC 7592 fields are kept only as a pair: an address with no token, or a token with no address,
  // cannot delete anything, and a half-remembered registration is worse than an honestly absent one.
  const clientUri = typeof parsed.registration_client_uri === 'string' ? parsed.registration_client_uri.slice(0, 2048) : ''
  const accessToken = typeof parsed.registration_access_token === 'string' ? parsed.registration_access_token.slice(0, 2048) : ''
  return {
    client: {
      clientId: parsed.client_id.slice(0, 512),
      clientSecret: typeof parsed.client_secret === 'string' ? parsed.client_secret.slice(0, 2048) : '',
    },
    registration: clientUri && accessToken ? { clientUri, accessToken } : null,
  }
}

/**
 * Ask the issuer to forget this app.
 *
 * RFC 7592 gives a dynamically registered client the address of its own registration and a token good for
 * exactly one thing: deleting it. This is not the same act as clearing the token — a reader logging out is
 * not a reader uninstalling — so it is its own function with its own route, and it is the only place that
 * tells the third party anything about the reader's decision to stop.
 *
 * A server that never handed out those two fields cannot be asked, which is why the caller checks for them
 * before getting here. A call that fails to reach the issuer returns false rather than throwing: the local
 * registration is worth clearing either way, and the reader is owed an honest answer about which half ran.
 */
export async function deleteMcpOAuthClient(fetchImpl: FetchLike, registration: McpOAuthRegistration): Promise<boolean> {
  const problem = mcpUrlProblem(registration.clientUri)
  if (problem) return false
  try {
    const response = await fetchImpl(registration.clientUri, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${registration.accessToken}`, accept: 'application/json' },
    })
    // 204 is the spec's own answer; a server that has already forgotten this client answers 404, which is
    // the outcome that was wanted, not a failure. Anything else means the registration is still there.
    return response.ok || response.status === 404
  } catch {
    return false
  }
}

/** 43 to 128 characters of URL-safe randomness: the length PKCE allows, from bytes it cannot be guessed from. */
export function newCodeVerifier(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32))).slice(0, 43)
}

export function newOAuthState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)))
}

/** The PKCE commitment that goes out with the redirect; the verifier stays here until the code comes back. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier) as BufferSource)
  return toBase64Url(new Uint8Array(digest))
}

/**
 * The address the reader's browser has to visit.
 *
 * `resource` is sent because RFC 8707 lets the server bind the token to this one MCP server rather than to
 * the client in general — a token minted for one resource should not work at another.
 */
export async function buildAuthorizeUrl(
  endpoints: McpOAuthEndpoints,
  client: McpOAuthClient,
  redirectUri: string,
  state: string,
  verifier: string,
  resource: string,
): Promise<string> {
  const challenge = await pkceChallenge(verifier)
  const url = new URL(endpoints.authorizationEndpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', client.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (endpoints.scopes.length) url.searchParams.set('scope', endpoints.scopes.join(' '))
  url.searchParams.set('resource', resource)
  return url.toString()
}

/** Whether the state coming back is the one that went out — the check that makes the callback a reply, not a request. */
export function oauthStateMatches(expected: string, received: string): boolean {
  return expected.length > 0 && received.length > 0 && timingSafeEqual(expected.slice(0, 256), received.slice(0, 256))
}

function tokenShape(body: Record<string, unknown>, now: number): McpOAuthTokens {
  const access = typeof body.access_token === 'string' ? body.access_token : ''
  if (!access) throw ApiError.badRequest('The authorization server answered without an access token.')
  const seconds = Number(body.expires_in)
  return {
    access: access.slice(0, 8192),
    refresh: typeof body.refresh_token === 'string' ? body.refresh_token.slice(0, 8192) : '',
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? now + seconds * 1000 : 0,
    tokenType: typeof body.token_type === 'string' && body.token_type ? body.token_type.slice(0, 32) : 'Bearer',
  }
}

/**
 * One POST to the token endpoint, whichever grant it is for.
 *
 * Form-encoded and unauthenticated-but-for-the-client-fields, which is what a `token_endpoint_auth_method:
 * none` client registered above is entitled to send. A secret is included only when the issuer handed one out.
 */
async function tokenRequest(
  fetchImpl: FetchLike,
  endpoints: McpOAuthEndpoints,
  client: McpOAuthClient,
  form: Record<string, string>,
  what: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId })
  if (client.clientSecret) body.set('client_secret', client.clientSecret)
  let response: Response
  try {
    response = await fetchImpl(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    })
  } catch {
    throw ApiError.badRequest(`The ${what} could not be reached.`)
  }
  const text = (await response.text().catch(() => '')).slice(0, MAX_METADATA_BYTES)
  let parsed: Record<string, unknown> | null = null
  try {
    const value: unknown = JSON.parse(text)
    parsed = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    parsed = null
  }
  if (!response.ok || !parsed) {
    // The upstream body is deliberately not repeated: an OAuth error response quotes the client secret back
    // in its `description` far more often than is comfortable.
    throw ApiError.badRequest(`The ${what} refused the credentials (HTTP ${response.status}).`)
  }
  return parsed
}

export async function exchangeMcpOAuthCode(
  fetchImpl: FetchLike,
  endpoints: McpOAuthEndpoints,
  client: McpOAuthClient,
  input: { code: string, redirectUri: string, verifier: string, resource: string },
  now = Date.now(),
): Promise<McpOAuthTokens> {
  const body = await tokenRequest(fetchImpl, endpoints, client, {
    grant_type: 'authorization_code',
    code: input.code.slice(0, 4096),
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
    resource: input.resource,
  }, 'authorization server')
  return tokenShape(body, now)
}

export async function refreshMcpOAuthTokens(
  fetchImpl: FetchLike,
  endpoints: McpOAuthEndpoints,
  client: McpOAuthClient,
  refreshToken: string,
  resource: string,
  now = Date.now(),
): Promise<McpOAuthTokens> {
  const body = await tokenRequest(fetchImpl, endpoints, client, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    resource,
  }, 'authorization server')
  const fresh = tokenShape(body, now)
  // A server that omits the refresh token on refresh means "the old one still works", per RFC 6749 §6.
  return fresh.refresh ? fresh : { ...fresh, refresh: refreshToken }
}

/** Whether the stored token has to be exchanged again before it can be sent. */
export function oauthTokenExpired(tokens: McpOAuthTokens | null, now = Date.now()): boolean {
  if (!tokens) return true
  return tokens.expiresAt > 0 ? tokens.expiresAt - EXPIRY_MARGIN_MS <= now : false
}

/** The header a live request carries, or nothing when the token type says something this client cannot send. */
export function oauthBearerHeader(tokens: McpOAuthTokens): string {
  if (tokens.tokenType.toLowerCase() !== 'bearer') {
    throw ApiError.badRequest(`This authorization server issues ${tokens.tokenType} tokens, which this client cannot send.`)
  }
  return `Bearer ${tokens.access}`
}

/**
 * The state parameter, which is also the lookup.
 *
 * The callback arrives with `code` and `state` and nothing else — no server id, because the identity
 * provider does not carry one. Putting the row's own id in front of the random half is what makes the
 * callback find its server in one read; the random half is what makes the finding mean anything, since a
 * guessed id without the matching half is refused below.
 */
function encodeState(serverId: string, token: string): string {
  return `${serverId}.${token}`
}

function decodeState(state: string): { serverId: string, token: string } | null {
  const split = state.indexOf('.')
  if (split <= 0) return null
  const serverId = state.slice(0, split)
  const token = state.slice(split + 1)
  return isValidId(serverId) && token.length >= 16 ? { serverId, token } : null
}

/**
 * Send the reader to their identity provider.
 *
 * Discovery and registration happen here, once, so the redirect that follows carries nothing the server
 * has not already agreed to. The verifier and state live in the vault until the code comes back, which is
 * the only reason a worker with no session of its own can answer a callback two requests later.
 */
export async function startMcpAuthorization(input: {
  store: AssistantStore
  fetchImpl?: FetchLike
  serverId: string
  mcpUrl: string
  clientName: string
  redirectUri: string
  suppliedClientId?: string
  resourceMetadataUrl?: string
}): Promise<string> {
  const endpoints = await discoverMcpOAuth(input.fetchImpl ?? fetchOAuth, input.mcpUrl, input.resourceMetadataUrl)
  const existing = await input.store.mcpAuthorization(input.serverId)
  // A client this app already registered here is reused rather than registered again. A reader who presses
  // Authorize a second time means "log in again", not "install the app twice" — and a second registration
  // would quietly abandon the first one, which nobody would then be able to withdraw.
  const known = existing?.secrets.registration ? existing.secrets : null
  const registered = known && !input.suppliedClientId
    ? { client: { clientId: known.clientId, clientSecret: known.clientSecret }, registration: known.registration }
    : await registerMcpOAuthClient(
      input.fetchImpl ?? fetchOAuth,
      endpoints,
      input.redirectUri,
      input.clientName,
      existing?.secrets.clientId || input.suppliedClientId || '',
    )
  const client = registered.client
  const pending = { verifier: newCodeVerifier(), state: encodeState(input.serverId, newOAuthState()), startedAt: Date.now() }
  const secrets: McpOAuthSecrets = {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    registration: registered.registration,
    // A second press before the first one came back is a reader trying again, not a new agreement: the
    // tokens they already have stay, and only the in-flight round trip is replaced.
    tokens: existing?.secrets.tokens ?? null,
    pending,
  }
  const url = await buildAuthorizeUrl(endpoints, client, input.redirectUri, pending.state, pending.verifier, input.mcpUrl)
  await input.store.setMcpAuthorization(input.serverId, {
    ...endpoints,
    clientId: client.clientId,
    dynamic: Boolean(registered.registration),
    authorized: Boolean(secrets.tokens),
    expiresAt: secrets.tokens?.expiresAt ?? 0,
  }, secrets)
  return url
}

/**
 * Take the code back and put a token in its place.
 *
 * The three things this has to get right are the state (this is the only place a stranger can push a URL at
 * the app on the third party's behalf), the verifier (which is what makes a stolen code worthless), and the
 * redirect (which has to be byte-identical to the one registered). Everything else is the issuer's problem.
 */
export async function finishMcpAuthorization(input: {
  store: AssistantStore
  fetchImpl?: FetchLike
  state: string
  code: string
  /** What the provider sent back in `error`, when it sent an error rather than a code. */
  providerError?: string
  redirectUri: string
}): Promise<{ serverId: string, label: string }> {
  const parts = decodeState(input.state)
  if (!parts) throw ApiError.badRequest('This authorization reply does not belong to any server here.')
  // Read through the caller's own store, which is built from this session's user id: another account that
  // guessed this server id has no row to answer, and the reply dies here rather than at the token endpoint.
  const record = await input.store.mcpServerRecord(parts.serverId)
  const found = record ? await input.store.mcpAuthorization(parts.serverId) : null
  if (!record || !found) throw ApiError.badRequest('This authorization reply does not belong to any server here.')
  const pending = found.secrets.pending
  if (!pending || !oauthStateMatches(pending.state, input.state)) {
    throw ApiError.forbidden('The state on this reply does not match the one this server asked for.')
  }
  if (pendingIsStale(pending)) throw ApiError.badRequest('That authorization took too long. Start it again.')
  if (input.providerError) throw ApiError.badRequest(`${record.row.label} was not authorized: ${input.providerError.slice(0, 200)}`)

  const client: McpOAuthClient = { clientId: found.secrets.clientId, clientSecret: found.secrets.clientSecret }
  const tokens = await exchangeMcpOAuthCode(input.fetchImpl ?? fetchOAuth, found.status, client, {
    code: input.code,
    redirectUri: input.redirectUri,
    verifier: pending.verifier,
    resource: record.row.url,
  })
  await input.store.setMcpAuthorization(parts.serverId, { ...found.status, clientId: client.clientId, authorized: true, expiresAt: tokens.expiresAt }, {
    ...found.secrets,
    tokens,
    pending: null,
  })
  return { serverId: parts.serverId, label: record.row.label }
}

/**
 * The headers one request to this server carries right now: its stored ones, with the token on top.
 *
 * The token wins the `Authorization` slot when both exist, because a reader who has just been through their
 * identity provider means that. Everything else the server was configured with — an org header, a version
 * pin — travels unchanged.
 *
 * This is the one entry point callers should use. Three places open a session with a third party (the turn,
 * the settings screen's test button, and the replay of a call), and a rule as easy to forget as "remember to
 * send the token" belongs in one function rather than in three comments.
 */
export async function withMcpOAuthHeaders(
  store: AssistantStore,
  serverId: string,
  mcpUrl: string,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  return { ...headers, ...await mcpOAuthHeaders({ store, serverId, mcpUrl }) }
}

/**
 * The header one request to this server carries, refreshed on the way past if it has to be.
 *
 * Returns an empty map when the reader never authorized this server, which is what lets a static-header
 * server keep working exactly as it did. A token that has expired with no refresh token is a dead end and
 * says so, because the settings screen is where the reader can do something about it.
 */
export async function mcpOAuthHeaders(input: {
  store: AssistantStore
  fetchImpl?: FetchLike
  serverId: string
  mcpUrl: string
}): Promise<Record<string, string>> {
  const found = await input.store.mcpAuthorization(input.serverId)
  if (!found?.secrets.tokens) return {}
  const { status, secrets } = found
  const tokens = secrets.tokens!
  const client: McpOAuthClient = { clientId: secrets.clientId, clientSecret: secrets.clientSecret }
  if (!oauthTokenExpired(tokens)) return { Authorization: oauthBearerHeader(tokens) }
  if (!tokens.refresh) throw ApiError.badRequest(`${status.issuer}'s access token has expired and the server gave no refresh token, so it needs authorizing again.`)
  const fresh = await refreshMcpOAuthTokens(input.fetchImpl ?? fetchOAuth, status, client, tokens.refresh, input.mcpUrl)
  await input.store.setMcpAuthorization(input.serverId, { ...status, authorized: true, expiresAt: fresh.expiresAt }, { ...secrets, tokens: fresh })
  return { Authorization: oauthBearerHeader(fresh) }
}
export function pendingIsStale(pending: McpOAuthSecrets['pending'], now = Date.now()): boolean {
  return Boolean(pending) && now - (pending?.startedAt ?? 0) > PENDING_AUTH_LIVES_MS
}
