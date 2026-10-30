import { newApiTesterId } from '@shared/development/api-tester/ids'
import type {
  ApiTesterState,
  EnvVariable,
  HistoryEntry,
  HttpRequestConfig,
  ResponseResult,
  ScriptContext,
} from '@shared/development/api-tester/types'
import { appendHistory } from './api'
import { executeRequest, RelayClientError } from './lib/relay-client'
import { runPreScript, runTests } from './lib/script-sandbox'
import { activeVariables, variableRecord, type Variable } from './lib/variables'
import { beginRequest, cancelRequest, endRequest } from './lib/inflight'
import { t } from '../../../lib/i18n'
import { useUi } from '../../../store/ui'
import { useApiTesterStore } from './store'

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

function applyEnvironmentChanges(store: typeof useApiTesterStore, before: Record<string, string>, after: Record<string, string>): void {
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

  if (node.preScript?.trim()) {
    const context = contextFor(environment, {
      method: request.method,
      url: request.url,
      headers: request.headers,
      params: request.params,
      body: request.body,
    })
    const pre = await runPreScript(node.preScript, context)
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

  const controller = beginRequest(tabId)
  store.getState().setTabLoading(tabId, true)
  store.getState().setResult(tabId, null)
  store.getState().setTestResults(tabId, null)

  try {
    let result = await executeRequest(request, {
      variables,
      followRedirects: snapshot.state.settings.followRedirects,
      timeoutMs: snapshot.state.settings.timeoutMs,
      kind,
      signal: controller.signal,
    })
    if (result.error === 'request_timeout') result = { ...result, error: t('development.apitester.request_timeout', { ms: snapshot.state.settings.timeoutMs }) }
    store.getState().setResult(tabId, result)
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
    endRequest(tabId, controller)
    store.getState().setTabLoading(tabId, false)
  }
}

export function currentState(): ApiTesterState {
  return useApiTesterStore.getState().state
}
