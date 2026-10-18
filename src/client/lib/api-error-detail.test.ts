// @vitest-environment jsdom
/**
 * What a refused request says on the screen (audit §9 guard 4).
 *
 * `translateApiError` turns a route's code into one sentence in the reader's language, and that sentence
 * is deliberately generic: `bad_request` covers an unset name, an over-long one and a body that is not
 * JSON alike. The route usually names the field it refused, sometimes with a per-field reason — and that
 * used to be thrown away at the client boundary, which is how a save that failed on one empty box read as
 * "the request is invalid" for a week. Two things are pinned here: the generic sentence stays (it is the
 * translated half the reader understands), and the route's own reason, fields included, arrives under it.
 *
 * The second half is untrusted text from another process, so the rest of the file pins what that means:
 * one bounded plain line, no markup, no credentials, and nothing invented when the route said nothing.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from './api'
import { initI18n, t } from './i18n'
import { installTestGlobals } from './test-render'
import { SaveFailure } from '../features/chat/assistant-settings-shared'
import { useAssistant, type WriteFailure } from '../features/chat/assistant-store'
import { useUi } from '../store/ui'

/** A refusal, answered the way the worker answers it: a code, a sentence, and what the validator named. */
function refused(body: unknown, status = 400): Response {
  return new Response(JSON.stringify({ error: body }), { status, headers: { 'content-type': 'application/json' } })
}

/** Runs the real `request()` against a stubbed fetch and hands back the error it threw. */
async function captureError(body: unknown, status = 400): Promise<ApiError> {
  vi.stubGlobal('fetch', vi.fn(async () => refused(body, status)))
  try {
    await api.assistant.updateModel('m1', { label: '' })
  } catch (error) {
    return error as ApiError
  }
  throw new Error('a refused save that did not throw is the bug, not the case')
}

/** The line a settings form prints under its own headline, taken from the failure it was handed. */
async function failureTheFormSees(body: unknown): Promise<WriteFailure> {
  vi.stubGlobal('fetch', vi.fn(async () => refused(body)))
  const reported: WriteFailure[] = []
  await useAssistant.getState().updateModel('m1', { label: '' }, (failure) => { reported.push(failure) })
  return reported[0] ?? { headline: '', detail: null }
}

const fieldRefusal = {
  code: 'bad_request',
  message: 'A model name is required.',
  details: { title: 'String must contain at least one non-whitespace character' },
}

let root: Root
let host: HTMLElement
let toasts: object[]

beforeEach(async () => {
  await initI18n()
  installTestGlobals()
  toasts = []
  const real = useUi.getState().toast
  useUi.setState({ toast: ((input: object) => { toasts.push(input) }) as typeof real })
  useAssistant.setState({ loadSettings: vi.fn(async () => undefined), loadMcp: vi.fn(async () => undefined) })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the reason the route gave stays visible', () => {
  it('keeps the translated sentence and adds the field the validator refused', async () => {
    const error = await captureError(fieldRefusal)
    expect(error.message).toBe(t('api.error.bad_request'))
    expect(error.serverMessage).toContain('A model name is required.')
    expect(error.serverMessage).toContain('title')
    expect(error.serverMessage).toContain('non-whitespace')
  })

  it('carries the same line all the way to the form that prints it', async () => {
    const failure = await failureTheFormSees(fieldRefusal)
    expect(failure.headline).toBe(t('api.error.bad_request'))
    expect(failure.detail).toContain('A model name is required.')
    expect(failure.detail).toContain('title')
    // One failure, one surface: the form was handed it, so no toast goes out beside it.
    expect(toasts).toEqual([])
  })

  it('answers the download path with the reason too, not only the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused({
      code: 'payload_too_large',
      message: 'The archive holds 12 notes over the per-file ceiling.',
      details: { limit_bytes: 20_000_000, over_limit: ['alpha.md', 'beta.md'] },
    }, 413)))
    const error = await api.transfer.save('json').then(() => null).catch((caught: unknown) => caught as ApiError)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).serverMessage).toContain('12 notes')
    expect((error as ApiError).serverMessage).toContain('over_limit')
  })
})

describe('nothing is invented when the route said nothing', () => {
  it('leaves the line as exactly the sentence the route said', async () => {
    const error = await captureError({ code: 'bad_request', message: 'A model name is required.' })
    expect(error.serverMessage).toBe('A model name is required.')
  })

  it('says nothing extra for an empty details object', async () => {
    const error = await captureError({ code: 'bad_request', message: 'A model name is required.', details: {} })
    expect(error.serverMessage).toBe('A model name is required.')
  })

  it('carries no line when the route sent no body at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const error = await api.assistant.updateModel('m1', { label: 'x' })
      .then(() => null)
      .catch((caught: unknown) => caught as ApiError)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('unknown')
    expect((error as ApiError).serverMessage ?? null).toBeNull()
    expect((error as ApiError).message).toBe(t('api.request_failed_status', { status: 500 }))
  })

  it('does not print [object Object] for details that are not field reasons', async () => {
    const error = await captureError({
      code: 'bad_request',
      message: 'The library could not be stored',
      details: { first: { second: { third: { fourth: ['deep'] } } } },
    })
    expect(error.serverMessage).toContain('The library could not be stored')
    expect(error.serverMessage).not.toContain('[object Object]')
    expect(error.serverMessage).not.toContain('undefined')
  })
})

describe('the line is server text, so it is treated as untrusted', () => {
  it('collapses a hostile payload into one bounded plain line', async () => {
    const error = await captureError({
      code: 'bad_request',
      message: `bad\n\t<script>alert(1)</script>${'noise '.repeat(200)}`,
      details: { note: '<img src=x onerror=boom()>' },
    })
    const line = error.serverMessage ?? ''
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\t')
    expect(line.length).toBeLessThanOrEqual(240)
    // Kept as the characters they are: the line quotes the route, it is not markup to interpret.
    expect(line).toContain('<script>')
  })

  it('renders that line as text, never as markup', async () => {
    const error = await captureError({
      code: 'bad_request',
      message: 'Check the <img src=x onerror=boom()> field',
      details: { body: '<script>steal()</script>' },
    })
    act(() => {
      root.render(createElement(SaveFailure, {
        failure: { headline: t('api.error.bad_request'), detail: error.serverMessage ?? null },
      }))
    })
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert).toBeTruthy()
    expect(alert?.querySelector('script')).toBeNull()
    expect(alert?.querySelector('img')).toBeNull()
    expect(document.querySelectorAll('script')).toHaveLength(0)
    expect(alert?.textContent).toContain('<script>steal()</script>')
  })

  it('keeps a credential the route echoed out of the interface', async () => {
    const error = await captureError({
      code: 'bad_request',
      message: 'The key sk-abcdef1234567890abcdef was rejected',
      details: { token: 'AIzaSyD-supersecretvalue0123456789xyz' },
    })
    expect(error.serverMessage).not.toContain('sk-abcdef1234567890abcdef')
    expect(error.serverMessage).not.toContain('AIzaSyD-supersecretvalue0123456789xyz')
    expect(error.serverMessage).toContain('[redacted]')
    expect(error.serverMessage).toContain('was rejected')
  })

  it('hides a labelled key but keeps the field the route named', async () => {
    const error = await captureError({
      code: 'bad_request',
      message: 'The provider refused the key',
      details: { apiKey: 'supersecretvalue12345' },
    })
    expect(error.serverMessage).not.toContain('supersecretvalue12345')
    // Hiding the value must not hide the diagnosis: which field, and that a key was what it was about.
    expect(error.serverMessage).toContain('apiKey')
    expect(error.serverMessage).toContain('[redacted]')
  })
})
