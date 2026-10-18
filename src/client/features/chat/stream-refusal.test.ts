// @vitest-environment jsdom
/**
 * What a refused turn says on its way out of the browser.
 *
 * A turn the worker never started is answered with a status and a JSON body rather than with a stream, and
 * this is the one request in the app that reads its own failure instead of going through `request()` — which
 * is how it came to lose the half every other surface kept. `translateApiError` renders `bad_request` as one
 * sentence covering every mistake that code is answered with, while the route names the thing it refused:
 * "a model name is required", "the daily limit of 200 requests is reached". The stream helper kept the code
 * and its own English fallback, so a reader who sent a turn on a model that is not theirs was told "the
 * request is invalid" and had nothing in the interface to say which field, or why.
 *
 * What is pinned here is therefore both halves — the translated headline and the route's reason under it —
 * and that they are the *same* two halves the JSON path produces for the same body. The flattening that
 * keeps a reason readable (one bounded line, control characters gone, a credential taken out) is written
 * once, so a second copy of it in this file's subject would be a second set of rules to keep in step.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../../lib/api'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { streamAssistantTurn } from './stream'

/** A refusal shaped the way the worker shapes one: a code, a sentence, and what the validator named. */
function refused(body: unknown, status = 400): Response {
  return new Response(JSON.stringify({ error: body }), { status, headers: { 'content-type': 'application/json' } })
}

/** Ask for one turn against a stubbed transport and hand back the error it threw. */
async function refusalOfTheTurn(body: unknown, status = 400): Promise<ApiError> {
  vi.stubGlobal('fetch', vi.fn(async () => refused(body, status)))
  try {
    await streamAssistantTurn({ message: 'what changed this week?' }, () => undefined, new AbortController().signal)
  } catch (error) {
    return error as ApiError
  }
  throw new Error('a refused turn that did not throw is the bug, not the case')
}

/** The same body read by the ordinary JSON path, which is the implementation this one has to agree with. */
async function refusalOfAJsonRoute(body: unknown, status = 400): Promise<ApiError> {
  vi.stubGlobal('fetch', vi.fn(async () => refused(body, status)))
  try {
    await api.assistant.updateModel('m1', { label: '' })
  } catch (error) {
    return error as ApiError
  }
  throw new Error('a refused save that did not throw is the bug, not the case')
}

const turnModelRefusal = {
  code: 'bad_request',
  message: 'A model name is required.',
  details: { modelId: 'The model named for this turn is not an enabled chat model of this account.' },
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a turn the worker refused before it started', () => {
  it('keeps the field the route named under the generic refusal', async () => {
    const error = await refusalOfTheTurn(turnModelRefusal)
    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(400)
    expect(error.code).toBe('bad_request')
    // The headline is the app's own sentence for the code, in the reader's language.
    expect(error.message).toBe(t('api.error.bad_request'))
    // And the reason the code cannot carry survives beside it.
    expect(error.serverMessage).toContain('A model name is required.')
    expect(error.serverMessage).toContain('modelId')
    expect(error.serverMessage).toContain('not an enabled chat model')
  })

  it('says exactly what the JSON path says for the same body', async () => {
    const turn = await refusalOfTheTurn(turnModelRefusal)
    const json = await refusalOfAJsonRoute(turnModelRefusal)
    expect(turn.serverMessage).toBe(json.serverMessage)
    expect(turn.message).toBe(json.message)
    expect(turn.code).toBe(json.code)
  })

  it('carries the day’s budget ceiling as the reason a turn did not start', async () => {
    const error = await refusalOfTheTurn({
      code: 'conflict',
      message: 'The daily limit of 200 assistant requests is reached. It is adjustable in Assistant settings.',
    }, 409)
    expect(error.message).toBe(t('api.error.conflict'))
    expect(error.serverMessage).toContain('daily limit of 200')
    expect(error.serverMessage).toContain('adjustable in Assistant settings')
  })

  it('leaves the line as nothing when the route sent a code alone', async () => {
    const error = await refusalOfTheTurn({ code: 'bad_request' })
    expect(error.serverMessage ?? null).toBeNull()
    expect(error.message).toBe(t('api.error.bad_request'))
  })
})

describe('a failure that is not a JSON refusal', () => {
  it('still surfaces an error rather than a stalled stream, in the app’s own words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<h1>Bad gateway</h1>', { status: 502 })))
    const error = await streamAssistantTurn({ message: 'hello' }, () => undefined, new AbortController().signal)
      .then(() => null)
      .catch((caught: unknown) => caught as ApiError)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('unknown')
    expect((error as ApiError).serverMessage ?? null).toBeNull()
    // The reader's language, not the helper's own English sentence — the same fallback every other call gets.
    expect((error as ApiError).message).toBe(t('api.request_failed_status', { status: 502 }))
  })

  it('invents no reason for an empty refusal body', async () => {
    const error = await refusalOfTheTurn(null, 500)
    expect(error.code).toBe('unknown')
    expect(error.serverMessage ?? null).toBeNull()
    expect(error.message).toBe(t('api.request_failed_status', { status: 500 }))
  })
})
