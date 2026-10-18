// @vitest-environment jsdom
/**
 * Where a refusal that only reaches a toast still says which field it refused.
 *
 * `describeFailure` already splits a failure into the app's own headline and the route's line about the
 * field, and a settings form prints both. Every other write in this store answers a failure with a toast —
 * and a toast printed the headline alone, so the detail line `routeApiError()` went to some trouble to keep
 * was dropped at the last step for exactly the actions a reader cannot retry in place: archiving a thread,
 * removing a server, running a tool again. The same flattening happens for the surfaces that hold one string
 * rather than two lines: a stopped turn's bubble, a tool row's failure, a vendor listing that never arrived.
 *
 * So the contract pinned here is two-sided. When the route named something, that line comes along as the
 * toast's description, rendered as plain text because it is another process's writing. When it said nothing,
 * the toast is exactly what it was before: one line, and no empty description bolted onto it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { ApiError, api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../lib/test-render'
import { Toaster } from '../../components/feedback'
import { useUi } from '../../store/ui'
import { stopRemoteStreamWatch, useAssistant } from './assistant-store'

const harness = vi.hoisted(() => ({
  /** What the transport answers with, decided per case: it rejects the turn the way a refusal does. */
  failure: null as unknown,
}))

// The transport, held by the test: the store's own job starts where the stream helper hands back a refusal.
vi.mock('./stream', () => ({
  streamAssistantTurn: (
    _input: Record<string, unknown>,
    _apply: (event: { type: string } & Record<string, unknown>) => void,
    _signal: AbortSignal,
  ) => new Promise<void>((_resolve, reject) => {
    reject(harness.failure ?? new Error('network down'))
  }),
}))

/** A refusal told the way `routeApiError()` tells one: a localised headline, and the route's line under it. */
function refusal(detail: string | undefined = 'A model name is required.'): ApiError {
  return new ApiError(400, 'bad_request', t('api.error.bad_request'), undefined, detail)
}

const original = useAssistant.getState()
const realToast = useUi.getState().toast
let toastSpy: ReturnType<typeof vi.fn>
let rendered: RenderedElement | null = null

/** The one input a toast was asked for, when exactly one went out. */
function onlyToast(): Record<string, unknown> {
  expect(toastSpy).toHaveBeenCalledTimes(1)
  return toastSpy.mock.calls[0]![0] as Record<string, unknown>
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  harness.failure = null
  toastSpy = vi.fn()
  useUi.setState({ toast: toastSpy as typeof realToast, toasts: [] })
  useAssistant.setState({
    ...original,
    activeId: null,
    messages: [],
    messagesReady: true,
    turn: null,
    compareTurn: null,
    remoteStreaming: false,
    pending: [],
    turnTools: [],
    turnScopes: [],
    fileIndex: {},
    compareOn: false,
    // The reads a write chains behind it are not this file's subject; the real ones would ask for a server.
    loadSettings: vi.fn(async () => undefined),
    loadMcp: vi.fn(async () => undefined),
    loadConversations: vi.fn(async () => undefined),
    refreshAfterTurn: vi.fn(async () => undefined),
  })
})

afterEach(() => {
  stopRemoteStreamWatch()
  rendered?.unmount()
  rendered = null
  useAssistant.setState(original, true)
  useUi.setState({ toast: realToast, toasts: [] })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a write whose only failure surface is a toast', () => {
  it('carries the route’s line as the description when it named one', async () => {
    vi.spyOn(api.assistant, 'updateModel').mockRejectedValue(refusal())
    expect(await useAssistant.getState().updateModel('m1', { reasoning: 'off' })).toBe(false)
    expect(onlyToast()).toEqual({
      title: t('api.error.bad_request'),
      description: 'A model name is required.',
      tone: 'danger',
    })
  })

  it('carries a field reason from a write that has no form to print it', async () => {
    vi.spyOn(api.assistant, 'removeMcpServer').mockRejectedValue(new ApiError(
      400,
      'bad_request',
      t('api.error.bad_request'),
      undefined,
      'The label must not be blank — name: String must contain at least one non-whitespace character',
    ))
    await useAssistant.getState().removeMcpServer('s1')
    expect(onlyToast().description).toContain('name')
    expect(onlyToast().description).toContain('non-whitespace')
  })

  it('stays the one-line toast it was when the route said nothing', async () => {
    vi.spyOn(api.assistant, 'removeMcpServer').mockRejectedValue(new ApiError(500, 'internal', t('api.error.internal')))
    await useAssistant.getState().removeMcpServer('s1')
    const input = onlyToast()
    expect(input).toEqual({ title: t('api.error.internal'), tone: 'danger' })
    // Not an empty description riding along on every toast: a surface prints it only where there is one.
    expect(Object.hasOwn(input, 'description')).toBe(false)
  })

  it('invents no description for a failure that never reached a route', async () => {
    vi.spyOn(api.assistant, 'removeMcpServer').mockRejectedValue(new Error('offline'))
    await useAssistant.getState().removeMcpServer('s1')
    expect(onlyToast()).toEqual({ title: 'offline', tone: 'danger' })
  })

  it('keeps one failure on one surface: a form that was handed it still gets no toast', async () => {
    vi.spyOn(api.assistant, 'updateModel').mockRejectedValue(refusal())
    const reported: { headline: string, detail: string | null }[] = []
    expect(await useAssistant.getState().updateModel('m1', { label: '' }, (failure) => {
      reported.push(failure)
    })).toBe(false)
    expect(reported).toEqual([{ headline: t('api.error.bad_request'), detail: 'A model name is required.' }])
    expect(toastSpy).not.toHaveBeenCalled()
  })
})

describe('a surface that holds a single line', () => {
  it('writes the reason onto the replay a tool row prints', async () => {
    vi.spyOn(api.assistant, 'replayMcpTool').mockRejectedValue(refusal('The stored call has no arguments.'))
    const result = await useAssistant.getState().replayMcpTool('c1', 'm1', 't1')
    expect(result.ok).toBe(false)
    expect(result.error).toContain(t('api.error.bad_request'))
    expect(result.error).toContain('The stored call has no arguments.')
  })

  it('writes the reason onto the turn the reader is looking at', async () => {
    harness.failure = new ApiError(
      409,
      'conflict',
      t('api.error.conflict'),
      undefined,
      'The daily limit of 200 assistant requests is reached. It is adjustable in Assistant settings.',
    )
    useAssistant.setState({ activeId: 'c1' })
    expect(await useAssistant.getState().send('what changed this week?')).toBe(false)
    const line = useAssistant.getState().turn?.error ?? ''
    expect(line).toContain(t('api.error.conflict'))
    expect(line).toContain('daily limit of 200')
  })

  it('says nothing extra when the route had nothing extra to say', async () => {
    harness.failure = new ApiError(400, 'bad_request', t('api.error.bad_request'))
    useAssistant.setState({ activeId: 'c1' })
    await useAssistant.getState().send('what changed this week?')
    expect(useAssistant.getState().turn?.error).toBe(t('api.error.bad_request'))
  })
})

describe('the toast prints server text as text', () => {
  it('shows the route’s line under the headline without interpreting it', async () => {
    useUi.setState({ toast: realToast })
    vi.spyOn(api.assistant, 'removeMcpServer').mockRejectedValue(new ApiError(
      400,
      'bad_request',
      t('api.error.bad_request'),
      undefined,
      'The name <img src=x onerror=boom()> was refused',
    ))
    await useAssistant.getState().removeMcpServer('s1')
    expect(useUi.getState().toasts).toHaveLength(1)

    rendered = renderElement(createElement(Toaster))
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(t('api.error.bad_request'))
    expect(alert?.textContent).toContain('The name <img src=x onerror=boom()> was refused')
    expect(document.querySelectorAll('img, script')).toHaveLength(0)
  })
})
