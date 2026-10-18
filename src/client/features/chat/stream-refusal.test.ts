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
 *
 * One block is the failure that never gets as far as a refusal: a request that dies before there are
 * any headers to read. It has no status and no body, so there is nothing to translate — which is exactly
 * how it came to reach the reader as the browser's own sentence. The answer is the one `request()` already
 * gives for it, and the two paths are held to that answer again here.
 *
 * The last block is one step later than that: the worker started its answer, and the browser cannot start
 * reading it. That failure belongs to the engine — no `TextDecoderStream`, a body it will not pipe — and it
 * arrives as a `TypeError` in English, which is what used to be printed. It is also the one failure of this
 * turn with no half answer behind it, so the sentence it gets cannot be the broken-stream one either: that
 * one tells the reader to press 「继续生成」, and nothing here draws that control.
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

describe('a turn whose request died before there were headers', () => {
  /** Ask for a turn over a transport that answers with the browser's own network failure. */
  async function turnOverADeadConnection(): Promise<unknown> {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    try {
      await streamAssistantTurn({ message: 'what changed this week?' }, () => undefined, new AbortController().signal)
    } catch (error) {
      return error
    }
    throw new Error('a turn whose request never got a response has to answer with an error')
  }

  /** The same failure read by the ordinary JSON path, which is the answer the turn has to agree with. */
  async function jsonRouteOverADeadConnection(): Promise<ApiError> {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    try {
      await api.assistant.updateModel('m1', { label: '' })
    } catch (error) {
      return error as ApiError
    }
    throw new Error('a request that never reached the network has to answer with an error')
  }

  it('says the same thing the JSON path says when the request itself fails', async () => {
    const turn = await turnOverADeadConnection()
    expect(turn, 'a request that never got a response is still the app’s own news, not the browser’s').toBeInstanceOf(ApiError)
    expect((turn as ApiError).status).toBe(0)
    expect((turn as ApiError).code).toBe('offline')
    expect((turn as ApiError).message).toBe(t('api.no_network_connection'))
    // The sentence is not written here a second time: it is the one every other call in the app answers a
    // failed request with, so the two paths have to agree on it for the same failure.
    const json = await jsonRouteOverADeadConnection()
    expect((turn as ApiError).message).toBe(json.message)
    expect((turn as ApiError).code).toBe(json.code)
    expect((turn as ApiError).status).toBe(json.status)
  })

  it('leaves a stop pressed before the headers the reader’s own abort', async () => {
    // An abort on this path is not a network failure and must not be dressed as one: the reader pressed
    // Stop, and `send` settles the turn as a stop only while the error says so.
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    const pending = streamAssistantTurn({ message: 'what changed this week?' }, () => undefined, controller.signal)
    controller.abort()
    const error = await pending.then(() => null).catch((caught: unknown) => caught as Error)
    expect((error as Error).name).toBe('AbortError')
    expect(error).not.toBeInstanceOf(ApiError)
  })
})

describe('a reply this browser could not start reading', () => {
  /**
   * Ask for a turn over a response the worker did start, and that fails at the one step which is the
   * engine's own work rather than this app's: building the reader that turns bytes into text.
   *
   * Two shapes reach it. `TextDecoderStream` may simply not exist in the browser, and then the constructor
   * throws before anything is piped. Or the body may refuse to be piped — a stream the engine already
   * handed somewhere else — and then `pipeThrough` throws, which is what `body` here stands in for. Both
   * fail before a single word of the answer has been read, and both used to fail *loudly*: the engine's
   * own `TypeError` text went straight up into the bubble.
   */
  async function turnOverAnUnreadableStream(body?: unknown): Promise<unknown> {
    const response = new Response(new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }))
    if (body !== undefined) Object.defineProperty(response, 'body', { value: body })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    try {
      await streamAssistantTurn({ message: 'what changed this week?' }, () => undefined, new AbortController().signal)
    } catch (error) {
      return error
    }
    throw new Error('a turn whose reader cannot be built has to answer with an error')
  }

  /**
   * What the interface is allowed to print for it, and the two things it is not.
   *
   * The sentence is the app's own, from the catalog, with no second line: an engine's `TypeError` names no
   * part of this app and translates to no language. And it is *not* `assistant.chat.stream_disconnected` —
   * that one ends by pointing the reader at 「继续生成」, which `canContinueAnswer` in `ChatView.tsx` draws
   * only for an answer with words in it. Nothing arrived on this path, so the control is not on the screen,
   * and a sentence that tells the reader to press it is a lie about the interface.
   */
  function expectTheAppOwnLineFor(error: unknown): ApiError {
    expect(error, 'a reader the browser could not build is still the app’s own news, not the engine’s').toBeInstanceOf(ApiError)
    const failure = error as ApiError
    expect(failure.message).toBe(t('assistant.chat.stream_reader_unavailable'))
    expect(failure.serverMessage ?? null).toBeNull()
    expect(failure.message).not.toBe(t('assistant.chat.stream_disconnected'))
    // Kept for debugging, never printed: see the comment on `StreamDisconnectedError`’s `cause`.
    expect(failure.cause).toBeInstanceOf(TypeError)
    return failure
  }

  it('says its own line when the engine has no decoder to read with', async () => {
    vi.stubGlobal('TextDecoderStream', undefined)
    const failure = expectTheAppOwnLineFor(await turnOverAnUnreadableStream())
    expect(failure.code).toBe('internal')
    expect(failure.message).not.toContain('TextDecoderStream')
    expect(failure.message).not.toContain('is not a constructor')
  })

  it('says its own line when the body refuses to be piped', async () => {
    const failure = expectTheAppOwnLineFor(await turnOverAnUnreadableStream({
      pipeThrough: () => { throw new TypeError('Cannot read properties of undefined (reading \'pipe\')') },
    }))
    expect(failure.code).toBe('internal')
    expect(failure.message).not.toContain('pipeThrough')
    expect(failure.message).not.toContain('Cannot read properties')
  })

  it('relabels nothing the reader stopped, because stopping cannot break this step', async () => {
    // The one place a turn can fail where the reader's own Stop is not a candidate: building the reader is
    // synchronous, so an abort cannot be what made it throw, and there is no `signal.aborted` exception to
    // keep here. A stop pressed just before this still reaches the reader as their own stop: `send` prints
    // no failure line at all while its signal says they pressed it.
    const controller = new AbortController()
    const response = new Response(new ReadableStream<Uint8Array>({ start: (streamController) => streamController.close() }))
    Object.defineProperty(response, 'body', {
      value: {
        pipeThrough: () => {
          controller.abort()
          throw new TypeError('pipeThrough is not a function')
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const error = await streamAssistantTurn({ message: 'what changed this week?' }, () => undefined, controller.signal)
      .then(() => null)
      .catch((caught: unknown) => caught as Error)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).message).toBe(t('assistant.chat.stream_reader_unavailable'))
  })
})
