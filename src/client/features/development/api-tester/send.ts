import { newApiTesterId } from '@shared/development/api-tester/ids'
import type {
  EnvVariable,
  HistoryEntry,
  HttpRequestConfig,
  ResponseResult,
  ScriptContext,
} from '@shared/development/api-tester/types'
import { appendHistory, exchangeOAuthToken } from './api'
import { executeRequest, RelayClientError } from './lib/relay-client'
import { runPreScript, runTests } from './lib/script-sandbox'
import { activeVariables, variableRecord, type Variable } from './lib/variables'
import { mergeResponseCookies } from './lib/cookies'
import { beginRequest, cancelRequest, discardRequest, endRequest, isCurrentRequest } from './lib/inflight'
import { t, type MessageKey } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useApiTesterStore } from './store'

const TRANSPORT_ERROR_KEYS: Record<string, MessageKey> = {
  upstream_unreachable: 'development.apitester.error.upstream_unreachable',
  response_too_large: 'development.apitester.error.response_too_large',
  too_many_redirects: 'development.apitester.error.too_many_redirects',
  invalid_redirect: 'development.apitester.error.invalid_redirect',
  cross_origin_redirect: 'development.apitester.error.cross_origin_redirect',
}

function contextFor(
  environment: Record<string, string>,
  request: { method: string; url: string; headers: HttpRequestConfig['headers']; params: HttpRequestConfig['params']; body?: string },
  response?: ScriptContext['response'],
): ScriptContext {
  const now = Date.now()
  return {
    environment,
    variables: { ...environment },
    request,
    response,
    dynamic: {
      timestamp: now,
      uuid: crypto.randomUUID(),
      iso: new Date(now).toISOString(),
    },
  }
}

export function applyEnvironmentChanges(store: typeof useApiTesterStore, before: Record<string, string>, after: Record<string, string>): void {
  const state = store.getState()
  const environment = state.state.environments.find((entry) => entry.id === state.state.activeEnvId)
  if (!environment) return
  let changed = false
  const variables: EnvVariable[] = []
  for (const variable of environment.variables) {
    if (after[variable.key] === undefined) {
      changed = true
      continue
    }
    if (after[variable.key] !== variable.value) {
      changed = true
      variables.push({ ...variable, value: after[variable.key]! })
    } else {
      variables.push(variable)
    }
  }
  const existing = new Set(variables.map((variable) => variable.key))
  for (const [key, value] of Object.entries(after)) {
    if (before[key] === value || existing.has(key)) continue
    changed = true
    variables.push({ id: newApiTesterId(), key, value, enabled: true })
  }
  if (changed) store.getState().updateEnvironment(environment.id, { variables })
}

/** One toast per outage, not one per request: a failing history endpoint would otherwise shout every send. */
let historyFailureNotified = false

function historyEntry(
  node: { name: string; tags: string[] },
  request: HttpRequestConfig,
  kind: HistoryEntry['kind'],
  result: ResponseResult,
): HistoryEntry {
  return {
    id: newApiTesterId(),
    ts: Date.now(),
    kind,
    method: request.method,
    url: request.url,
    name: node.name,
    status: result.status,
    durationMs: result.durationMs,
    sizeBytes: result.sizeBytes,
    request: {
      ...request,
      headers: request.headers.map((header) => ({ ...header })),
      params: request.params.map((param) => ({ ...param })),
      formFields: request.formFields.map((field) => ({ ...field })),
    },
    tags: [...node.tags],
  }
}

/** Refreshes an expired OAuth2 access token before the request; failure keeps the old token. */
async function refreshExpiredOAuth(
  store: typeof useApiTesterStore,
  nodeId: string,
  request: HttpRequestConfig,
): Promise<HttpRequestConfig> {
  const oauth = request.auth.type === 'oauth2' ? request.auth.oauth2 : undefined
  if (!oauth?.tokenUrl || !oauth.refreshToken || !oauth.expiresAt || Date.now() < oauth.expiresAt) return request
  try {
    const data = await exchangeOAuthToken({
      tokenUrl: oauth.tokenUrl,
      grantType: 'refresh_token',
      refreshToken: oauth.refreshToken,
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
    })
    if (data.error || !data.accessToken) {
      if (data.error) console.warn('[inkstone] API Tester OAuth refresh refused:', data.error)
      return request
    }
    const oauth2 = {
      ...oauth,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? oauth.refreshToken,
      tokenType: data.tokenType || oauth.tokenType || 'Bearer',
      expiresAt: data.expiresIn ? Date.now() + data.expiresIn * 1_000 : oauth.expiresAt,
    }
    const next = { ...request, auth: { ...request.auth, oauth2 } }
    store.getState().updateNode(nodeId, { request: next })
    return next
  } catch (error) {
    console.warn('[inkstone] API Tester OAuth refresh failed', error)
    useUi.getState().toast({ title: t('development.apitester.oauth_refresh_failed'), tone: 'warning' })
    return request
  }
}

export function cancelActiveRequest(tabId: string): void {
  cancelRequest(tabId)
}

export async function sendActiveRequest(): Promise<void> {
  const store = useApiTesterStore
  const snapshot = store.getState()
  const node = snapshot.state.nodes.find((entry) => entry.id === snapshot.activeId)
  if (!node || !node.request || node.kind === 'websocket') return
  const tabId = node.id
  const kind = (node.kind ?? 'rest') as HistoryEntry['kind']
  const baseVariables = activeVariables(snapshot.state)
  let environment = variableRecord(baseVariables)
  let request = node.request
  let variables: Variable[] = baseVariables

  // A send replaces whatever that tab was doing, including a request still in its pre-script phase.
  discardRequest(tabId)
  const controller = beginRequest(tabId)
  store.getState().setTabLoading(tabId, true)
  store.getState().setResult(tabId, null)
  store.getState().setTestResults(tabId, null)

  if (node.preScript?.trim()) {
    const context = contextFor(environment, {
      method: request.method,
      url: request.url,
      headers: request.headers,
      params: request.params,
      body: request.body,
    })
    const pre = await runPreScript(node.preScript, context)
    if (!isCurrentRequest(tabId, controller)) return
    if (controller.signal.aborted) {
      if (endRequest(tabId, controller)) store.getState().setTabLoading(tabId, false)
      return
    }
    if (pre.error) {
      store.getState().setResult(tabId, {
        status: 0,
        statusText: 'Pre-script Error',
        headers: [],
        contentType: '',
        sizeBytes: 0,
        durationMs: 0,
        body: '',
        redirected: false,
        url: request.url,
        error: t('development.apitester.pre_script_error', { msg: pre.error }),
      })
      if (endRequest(tabId, controller)) store.getState().setTabLoading(tabId, false)
      return
    }
    request = { ...request, headers: pre.headers ?? request.headers, params: pre.params ?? request.params }
    variables = [
      ...baseVariables.filter((variable) => !(variable.key in pre.variables) && !(variable.key in pre.env)),
      ...Object.entries(pre.variables).map(([key, value]) => ({ key, value, enabled: true })),
      ...Object.entries(pre.env).map(([key, value]) => ({ key, value, enabled: true })),
    ]
    applyEnvironmentChanges(store, environment, pre.env)
    environment = pre.env
  }

  request = await refreshExpiredOAuth(store, tabId, request)
  if (!isCurrentRequest(tabId, controller)) return
  if (controller.signal.aborted) {
    if (endRequest(tabId, controller)) store.getState().setTabLoading(tabId, false)
    return
  }

  try {
    let result = await executeRequest(request, {
      variables,
      followRedirects: snapshot.state.settings.followRedirects,
      timeoutMs: snapshot.state.settings.timeoutMs,
      kind,
      cookies: snapshot.state.cookies ?? [],
      signal: controller.signal,
    })
    if (result.error === 'request_timeout') result = { ...result, error: t('development.apitester.request_timeout', { ms: snapshot.state.settings.timeoutMs }) }
    else if (result.error) {
      const key = TRANSPORT_ERROR_KEYS[result.error]
      if (key) result = { ...result, error: t(key) }
    }
    if (!isCurrentRequest(tabId, controller)) return
    store.getState().setResult(tabId, result)
    if (result.cookies && result.cookies.length > 0) {
      store.getState().patchState((state) => ({
        ...state,
        cookies: mergeResponseCookies(state.cookies ?? [], result),
      }))
    }
    store.getState().updateNode(tabId, { lastStatus: result.status })

    if (node.tests?.trim()) {
      const headers: Record<string, string> = {}
      for (const header of result.headers) headers[header.key] = header.value
      const tests = await runTests(
        node.tests,
        contextFor(
          environment,
          { method: request.method, url: request.url, headers: request.headers, params: request.params, body: request.body },
          {
            status: result.status,
            statusText: result.statusText,
            headers,
            body: result.body,
            durationMs: result.durationMs,
            sizeBytes: result.sizeBytes,
          },
        ),
      )
      store.getState().setTestResults(tabId, { results: tests.results, error: tests.error })
      applyEnvironmentChanges(store, environment, tests.env)
    }

    const entry = historyEntry(node, request, kind, result)
    store.getState().appendHistoryLocal(entry)
    void appendHistory(snapshot.activeWorkspaceId, entry)
      .then(() => {
        historyFailureNotified = false
      })
      .catch((error) => {
        console.warn('[inkstone] API Tester history could not be saved', error)
        if (historyFailureNotified) return
        historyFailureNotified = true
        useUi.getState().toast({ title: t('development.apitester.history_save_failed'), tone: 'danger' })
      })
  } catch (error) {
    if (!isCurrentRequest(tabId, controller)) return
    const message = error instanceof RelayClientError
      ? error.code === 'url_required'
        ? t('development.apitester.url_required')
        : error.code === 'url_protocol'
          ? t('development.apitester.url_protocol')
          : t('development.apitester.request_cancelled')
      : error instanceof Error ? error.message : String(error)
    store.getState().setResult(tabId, {
      status: 0,
      statusText: 'Error',
      headers: [],
      contentType: '',
      sizeBytes: 0,
      durationMs: 0,
      body: '',
      redirected: false,
      url: request.url,
      error: message,
    })
  } finally {
    if (endRequest(tabId, controller)) store.getState().setTabLoading(tabId, false)
  }
}
