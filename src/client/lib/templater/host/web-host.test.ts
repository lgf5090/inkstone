import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_HEADER } from '@shared/constants'
import type { CapabilityProfile, HostResult, TemplateRunContext } from '../protocol'
import type { TemplaterErrorCode } from '../errors'
import { createWebHost, quoteDatabase, type ProxyReply, type WebHost, type WebHostDeps } from './web-host'

/**
 * The page's half of the network, tested at the two seams it has.
 *
 * One seam is the proxy: what the host tells `src/worker/routes/templater.ts` to fetch, and what it does
 * with the answer. The address rules — private targets, credentials in the address, redirects, ten seconds,
 * sixty-four kilobytes — are that route's and are pinned by `tests/templater-route.test.ts`; a second copy
 * here would be a second place for a blocked range to be unblocked by a typo, so nothing below restates
 * them. The other seam is the refusal: which code a template hears, and how much of it is a measurement.
 *
 * The composition a reader might expect in `daily_quote` and `random_picture` is deliberately not here,
 * because this module never does it. The blockquote (`> [!quote] `, `> \u2014 `), the `&w=`/`&h=` suffix, the
 * alt text and the `|size` variant are the frozen prelude's, built from the record this host answers, and
 * they are pinned where they live — `worker/bootstrap.test.ts:1259-1307`. What is checked here is that
 * record: the four fields, or the two quote members, or the three photo members, arriving as the proxy wrote
 * them.
 *
 * The global `fetch` is stubbed, as the rest of the app's tests stub it, wherever the door itself is the
 * subject; the relay is injected wherever the answer is, so a case does not pay for a request.
 */

const PROXY_PATH = '/api/templater/fetch'
const CALL = 'call-3'

/** Upstream's relay service for `random_picture`, restated as the address this host builds on. */
const UNSPLASH = 'https://templater-unsplash-2.fly.dev/'

/** The address a template would write, and the one every case below expects the door to be told. */
const TARGET = 'https://example.test/todos'

function context(overrides: Partial<TemplateRunContext> = {}): TemplateRunContext {
  // This host reads the run's id and its rights and nothing else: no note, no folder, no selection, so no
  // snapshot is built in order to hand it one.
  return {
    runId: 'run-1',
    mode: 'overwrite-active',
    capabilities: 'local',
    template: null,
    startedAt: 1_700_000_000_000,
    target: null,
    active: null,
    frozenTitle: 'Target',
    index: [],
    folders: [],
    libraryTemplates: [],
    locale: 'en-US',
    selection: '',
    ...overrides,
  }
}

type RelayAnswer = { ok: true; reply: ProxyReply } | { ok: false; code: TemplaterErrorCode; detail: string }

interface Relay {
  deps: WebHostDeps
  /** Every address the host told the proxy to fetch, in order. */
  urls: string[]
  /** How many times the reader's switch was consulted. */
  switchReads: number
}

/** The proxy as a test's, answering whatever the case says it answered. */
function relayWith(answer: () => RelayAnswer, webRequestsEnabled = true): Relay {
  const relay: Relay = {
    urls: [],
    switchReads: 0,
    deps: {
      webRequestsEnabled: () => {
        relay.switchReads += 1
        return webRequestsEnabled
      },
      fetchViaProxy: async (url) => {
        relay.urls.push(url)
        return answer()
      },
    },
  }
  return relay
}

/** The proxy's success shape, as `src/worker/routes/templater.ts` writes it. */
function envelope(text: string, init: { status?: number, contentType?: string } = {}): RelayAnswer {
  const status = init.status ?? 200
  return {
    ok: true,
    reply: { status, ok: status >= 200 && status <= 299, contentType: init.contentType ?? 'application/json', text },
  }
}

const PHOTO = '{"full":"https://images.unsplash.com/photo-1","photog":"Ada","photogUrl":"https://unsplash.com/@ada"}'

/** The refusal `fetchThroughProxy` builds for an address the route would not carry. */
const relayBlockedAnswer: RelayAnswer = { ok: false, code: 'web-blocked', detail: 'web-blocked' }

interface Fetched {
  input: string
  init: RequestInit
}

/**
 * The global `fetch`, stubbed.
 *
 * `respond` is called per request so one case can hand back a body and the next an error, and a returned
 * `Error` is *thrown* from the stub, which is how a lost network reaches a real `fetch`.
 */
function stubFetch(respond: (call: number) => Response | Error): { calls: Fetched[] } {
  const calls: Fetched[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
    calls.push({ input: String(input), init: init as RequestInit })
    const answer = respond(calls.length - 1)
    if (answer instanceof Error) throw answer
    return answer
  }))
  return { calls }
}

/** The route's refusal on the wire: `{ error: { code, message } }` under an HTTP status. */
function routeRefusal(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } })
}

function hostOver(deps: WebHostDeps, profile: CapabilityProfile = 'local', overrides: Partial<TemplateRunContext> = {}): WebHost {
  const host = createWebHost(deps)
  host.beginRun(context({ capabilities: profile, ...overrides }))
  return host
}

function ask(host: WebHost, method: string, args: unknown[] = [], runId = 'run-1'): Promise<HostResult> {
  return host({ runId, callId: CALL, method, args })
}

function refused(result: HostResult): { code: string; detail: string | undefined } {
  if (result.ok) throw new Error(`answered ${JSON.stringify(result.value)} instead of refusing`)
  return { code: result.code, detail: result.detail }
}

function answered(result: HostResult): unknown {
  if (!result.ok) throw new Error(`refused: ${result.code} ${result.detail ?? ''}`)
  return result.value
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('web.request', () => {
  it('posts the address to the one door and hands back the four fields the interpreter reads', async () => {
    const reply = { status: 200, ok: true, contentType: 'application/json', text: '{"todos":[{"title":"write it"}]}' }
    const door = stubFetch(() => new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } }))
    const host = hostOver({ webRequestsEnabled: () => true })

    expect(answered(await ask(host, 'web.request', [{ url: TARGET }]))).toEqual(reply)
    // The template's address never leaves through any other door.
    expect(door.calls).toHaveLength(1)
    expect(door.calls[0]!.input).toBe(PROXY_PATH)
    expect(door.calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(String(door.calls[0]!.init.body))).toEqual({ url: TARGET })
    // The app's own write marker and its session cookie, and nothing a template could name: no header and
    // no body field that would let `tp.web.request` dress itself up as something else to the route.
    expect(door.calls[0]!.init.credentials).toBe('same-origin')
    expect(door.calls[0]!.init.headers).toMatchObject({ 'content-type': 'application/json', [CLIENT_HEADER]: '1' })
  })

  it('passes a far-side failure through for the prelude to judge', async () => {
    // Upstream's own 2xx test is inverted and never fires; this port is stricter on purpose, and that
    // decision is the prelude's (`jsonFromResponse`, pinned at `worker/bootstrap.test.ts:1250`). A host that
    // refused first would take it away from the layer that pinned it, and leave that test describing a path
    // production no longer reaches.
    const door = stubFetch(() => new Response(JSON.stringify({ status: 404, ok: false, contentType: 'text/html', text: 'no such page' }), { status: 200 }))
    const host = hostOver({ webRequestsEnabled: () => true })
    expect(answered(await ask(host, 'web.request', [{ url: TARGET }])))
      .toEqual({ status: 404, ok: false, contentType: 'text/html', text: 'no such page' })
    expect(door.calls).toHaveLength(1)
  })

  it('refuses an address it cannot send, without reaching the door', async () => {
    const door = stubFetch(() => new Response('{"status":200,"ok":true,"contentType":"text/plain","text":""}', { status: 200 }))
    const host = hostOver({ webRequestsEnabled: () => true })
    expect(refused(await ask(host, 'web.request'))).toEqual({ code: 'path-invalid', detail: 'web.request:arg:0:type' })
    expect(refused(await ask(host, 'web.request', [TARGET]))).toEqual({ code: 'path-invalid', detail: 'web.request:arg:0:type' })
    expect(refused(await ask(host, 'web.request', [{ url: 7 }]))).toEqual({ code: 'path-invalid', detail: 'web.request:arg:0:type' })
    expect(refused(await ask(host, 'web.request', [{ url: '   ' }]))).toEqual({ code: 'path-invalid', detail: 'web.request:arg:0:empty' })
    expect(door.calls).toEqual([])
  })

  it('names the route’s own refusals as themselves', async () => {
    // These codes already have a sentence in `../errors.ts`, so a reader gets the reason rather than a
    // generic failure. A blocked address, a rights refusal from the route and an address that did not answer
    // are three different facts, and flattening them is how a reader ends up changing the wrong thing.
    const cases: { status: number, code: string, expected: TemplaterErrorCode }[] = [
      { status: 403, code: 'web-blocked', expected: 'web-blocked' },
      { status: 415, code: 'capability-blocked', expected: 'capability-blocked' },
      { status: 502, code: 'web-request-failed', expected: 'web-request-failed' },
    ]
    for (const one of cases) {
      stubFetch(() => routeRefusal(one.status, one.code, 'A sentence this deployment wrote in English'))
      const host = hostOver({ webRequestsEnabled: () => true })
      expect(refused(await ask(host, 'web.request', [{ url: TARGET }])), one.code)
        .toEqual({ code: one.expected, detail: one.code })
    }
  })

  it('reports a rate limit as a request that did not come back, not as a rights problem', async () => {
    // `too_many_attempts` is a fact about this minute, not about what this template may do. Reporting it as
    // `capability-blocked` would tell the reader their own template is not allowed online, and they would go
    // looking for a switch that was never the reason.
    stubFetch(() => routeRefusal(429, 'too_many_attempts', 'Too many web requests from this account.'))
    const host = hostOver({ webRequestsEnabled: () => true })
    const limited = refused(await ask(host, 'web.request', [{ url: TARGET }]))
    expect(limited).toEqual({ code: 'web-request-failed', detail: 'too_many_attempts' })
    expect(limited.code).not.toBe('capability-blocked')
    expect(limited.code).not.toBe('web-blocked')

    // …and the same for a request the route refused before it started, or an answer that was not an
    // envelope this file can read: the name is kept where the table has a sentence for it, and everything
    // else is a request that did not come back.
    stubFetch(() => routeRefusal(400, 'bad_request', 'A web address must be sent as text'))
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }])))
      .toEqual({ code: 'web-request-failed', detail: 'bad_request' })
    stubFetch(() => new Response('<html>gateway error</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }])))
      .toEqual({ code: 'web-request-failed', detail: 'unknown' })
  })

  it('distinguishes an address that never answered from one that took too long', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = hostOver({ webRequestsEnabled: () => true })

    // `AbortSignal.timeout` rejects with a `TimeoutError`, and the name is the only half of it this side can
    // read; the wait is this deployment's own measurement, so it needs no log line beside it.
    stubFetch(() => Object.assign(new Error('Signal timed out'), { name: 'TimeoutError' }))
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }])))
      .toEqual({ code: 'web-request-failed', detail: 'timeout' })
    expect(logged).not.toHaveBeenCalled()

    stubFetch(() => new TypeError('Failed to fetch'))
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }])))
      .toEqual({ code: 'web-request-failed', detail: 'offline' })
    expect(logged).toHaveBeenCalledWith('[inkstone] templater proxy request failed', expect.any(TypeError))
  })

  it('reports a proxy answer that is not the contract instead of answering it as empty text', async () => {
    // A 200 whose body is not the four fields is a bug in this deployment. Answering it as `''` would move
    // the bug inside the template, where it reads as a page with nothing on it.
    const MARKER = 'echo-me'
    const cases: [string, string][] = [
      ['a body that is not json', `${MARKER} not json at all`],
      ['a number where the status should be', JSON.stringify({ status: '200', ok: true, contentType: 'application/json', text: MARKER })],
      ['a bare string instead of a record', JSON.stringify(`${MARKER} a page`)],
      ['a body with no text field', JSON.stringify({ status: 200, ok: true, contentType: 'application/json' })],
      ['an empty body', ''],
    ]
    for (const [what, body] of cases) {
      stubFetch(() => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
      const host = hostOver({ webRequestsEnabled: () => true })
      const failure = refused(await ask(host, 'web.request', [{ url: TARGET }]))
      expect(failure, what).toEqual({ code: 'web-request-failed', detail: 'proxy-shape' })
      // The name of the bug is the measurement; the body that proved it is not handed to the template.
      expect(failure.detail, what).not.toContain(MARKER)
    }
  })

  it('answers a call whose own relay threw, and keeps the cause on the console', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = hostOver({
      webRequestsEnabled: () => true,
      fetchViaProxy: async () => { throw new Error('the relay said something in English') },
    })
    // Nothing here may reject: the worker is blocked on this one reply, and a missing reply is a run that
    // hangs until the idle guard takes the thread down.
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }]))).toEqual({ code: 'render-failed', detail: 'throw:web.request' })
    expect(logged).toHaveBeenCalledWith('[inkstone] templater web host failed', 'web.request', expect.any(Error))
  })
})

describe('web.dailyQuote', () => {
  it('sends the language the run resolved to the database that answers it', async () => {
    // Which language to ask in is the prelude's choice — an argument, then the reader's locale, then `en` —
    // and it arrives lowercased. Which address that name selects is this host's, and that is what is read
    // here: a lookup that quietly answered English for a registered language would ship a quote in the wrong
    // one with no failure to show for it.
    const spanish = relayWith(() => envelope('[{"quote":"Una frase","author":"Alguna"}]'))
    const host = hostOver(spanish.deps)
    answered(await ask(host, 'web.dailyQuote', ['es']))
    expect(spanish.urls).toHaveLength(1)
    expect(spanish.urls[0]).toContain('frases-inventario')
    expect(spanish.urls[0]).not.toContain('quotes-database')

    const unregistered = relayWith(() => envelope('[{"quote":"A line","author":"Someone"}]'))
    const hostEnglish = hostOver(unregistered.deps)
    answered(await ask(hostEnglish, 'web.dailyQuote', ['zh-cn']))
    expect(unregistered.urls[0]).toContain('quotes-database')
    expect(unregistered.urls[0]).not.toContain('frases-inventario')
  })

  it('answers the two members the prelude composes a quote block from', async () => {
    const quotes = relayWith(() => envelope('[{"quote":"A line worth keeping","author":"Someone","source":"a book"}]'))
    const host = hostOver(quotes.deps)
    // The record and nothing else: the `> [!quote] ` and the em dash are upstream's format and the prelude's
    // code, pinned at `worker/bootstrap.test.ts:1289`. A third member the database carries is dropped here
    // rather than smuggled into the note through the record.
    expect(answered(await ask(host, 'web.dailyQuote', ['en']))).toEqual({ quote: 'A line worth keeping', author: 'Someone' })
  })

  it('reads the language the way upstream does, with English underneath', () => {
    // Asserted by which database is answered rather than by restating two addresses: what has to be caught is
    // a lookup that answers English for a language the table holds, or a registered one for a tag nobody has.
    expect(quoteDatabase('es')).toContain('frases-inventario')
    expect(quoteDatabase('ES')).toContain('frases-inventario')
    expect(quoteDatabase('es-ES')).toContain('frases-inventario')
    expect(quoteDatabase('en')).toContain('quotes-database')
    expect(quoteDatabase('en-US')).toContain('quotes-database')
    expect(quoteDatabase('zh-CN')).toContain('quotes-database')
    expect(quoteDatabase('fr-FR')).toContain('quotes-database')
    expect(quoteDatabase('   ')).toContain('quotes-database')
    expect(quoteDatabase('es')).not.toBe(quoteDatabase('en'))
  })

  it('refuses a database that answered nothing it can quote, naming the half that failed', async () => {
    const cases: [string, RelayAnswer, string][] = [
      ['an empty list', envelope('[]'), 'web.dailyQuote'],
      ['a document rather than a list', envelope('{"quotes":[]}'), 'web.dailyQuote'],
      ['an entry with no text', envelope('[{"author":"Someone"}]'), 'web.dailyQuote'],
      ['an entry whose text is not text', envelope('[{"quote":7,"author":"Someone"}]'), 'web.dailyQuote'],
      ['a body that is not json', envelope('<html>no quotes here</html>', { contentType: 'text/html' }), 'json'],
      // The status is what a reader can act on, so it is kept wherever there is one.
      ['a database that was not there', envelope('not found', { status: 503 }), '503'],
    ]
    for (const [what, answer, detail] of cases) {
      const host = hostOver(relayWith(() => answer).deps)
      expect(refused(await ask(host, 'web.dailyQuote', ['en'])), what)
        .toEqual({ code: 'web-request-failed', detail })
    }
  })

  it('refuses an argument that is not a language name', async () => {
    const quotes = relayWith(() => envelope('[]'))
    const host = hostOver(quotes.deps)
    expect(refused(await ask(host, 'web.dailyQuote', [7 as unknown as string])))
      .toEqual({ code: 'render-failed', detail: 'web.dailyQuote:arg:0:type' })
    expect(refused(await ask(host, 'web.dailyQuote'))).toEqual({ code: 'render-failed', detail: 'web.dailyQuote:arg:0:type' })
    expect(quotes.urls).toEqual([])
  })
})

describe('web.randomPicture', () => {
  it('builds the relay address with the query as one parameter', async () => {
    // Upstream concatenates the query into the address, so a query holding `&` or `=` writes parameters into
    // the fetch the proxy is told to make. Encoding it here is the difference between a search and a request
    // the template never wrote.
    const picture = relayWith(() => envelope(PHOTO))
    const host = hostOver(picture.deps)
    answered(await ask(host, 'web.randomPicture', ['cats & dogs=more']))
    const address = new URL(picture.urls[0]!)
    expect(`${address.origin}${address.pathname}`).toBe(UNSPLASH)
    expect([...address.searchParams.entries()]).toEqual([['q', 'cats & dogs=more']])
  })

  it('asks the relay service plainly when the template named no query', async () => {
    const picture = relayWith(() => envelope(PHOTO))
    const host = hostOver(picture.deps)
    // The prelude sends `null` for an absent query, which is the only other shape this argument takes.
    expect(answered(await ask(host, 'web.randomPicture', [null]))).toEqual({
      full: 'https://images.unsplash.com/photo-1',
      photog: 'Ada',
      photogUrl: 'https://unsplash.com/@ada',
    })
    expect(picture.urls).toEqual([UNSPLASH])
  })

  it('hands the picture’s own address back untouched', async () => {
    // The `&w=`/`&h=` suffix, the `photo by …` alt and the `|size` variant are the prelude's, and they are
    // built on the assumption that `full` arrived exactly as the relay wrote it — so nothing here may
    // normalise, extend or shorten it. Pinned at `worker/bootstrap.test.ts:1259-1279` for the other half.
    const picture = relayWith(() => envelope(PHOTO))
    const host = hostOver(picture.deps)
    expect(answered(await ask(host, 'web.randomPicture', ['landscape']))).toEqual(JSON.parse(PHOTO))
  })

  it('refuses a relay answer that is not a picture, and passes a refusal through named', async () => {
    const cases: { what: string, answer: RelayAnswer, code: TemplaterErrorCode, detail: string }[] = [
      { what: 'no photographer', answer: envelope('{"full":"https://images.unsplash.com/photo-1","photogUrl":"https://unsplash.com/@ada"}'), code: 'web-request-failed', detail: 'web.randomPicture' },
      { what: 'a number where the address should be', answer: envelope('{"full":1,"photog":"Ada","photogUrl":"u"}'), code: 'web-request-failed', detail: 'web.randomPicture' },
      { what: 'a list rather than a record', answer: envelope(`[${PHOTO}]`), code: 'web-request-failed', detail: 'web.randomPicture' },
      { what: 'a body that is not json', answer: envelope('not json at all'), code: 'web-request-failed', detail: 'json' },
      // The door's own refusal is not flattened into "did not come back" on this path either: a blocked
      // address and a lost request are different things to a reader, and the prelude is not the only place
      // that gets to hear which.
      { what: 'a relay that refused the address', answer: relayBlockedAnswer, code: 'web-blocked', detail: 'web-blocked' },
    ]
    for (const one of cases) {
      const host = hostOver(relayWith(() => one.answer).deps)
      expect(refused(await ask(host, 'web.randomPicture', [null])), one.what)
        .toEqual({ code: one.code, detail: one.detail })
    }
  })

  it('refuses a query that is neither text nor nothing', async () => {
    const picture = relayWith(() => envelope('{}'))
    const host = hostOver(picture.deps)
    expect(refused(await ask(host, 'web.randomPicture', [7 as unknown as string])))
      .toEqual({ code: 'render-failed', detail: 'web.randomPicture:arg:0:type' })
    expect(picture.urls).toEqual([])
  })
})

describe('the door a run may not use', () => {
  it('refuses on the reader’s switch before a single address is sent', async () => {
    const relay = relayWith(() => envelope('{}'), false)
    const host = hostOver(relay.deps)
    for (const method of ['web.request', 'web.dailyQuote', 'web.randomPicture']) {
      const args = method === 'web.request' ? [{ url: TARGET }] : method === 'web.randomPicture' ? [null] : ['en']
      expect(refused(await ask(host, method, args)), method).toEqual({ code: 'web-disabled', detail: method })
    }
    // Read on every call rather than captured at startup: a reader who turns web requests off mid-run has to
    // find out on the next call, and one who turns them on must not be refused for the rest of the session.
    expect(relay.switchReads).toBe(3)
    expect(relay.urls).toEqual([])
  })

  it('refuses on the run’s rights before the switch is even read', async () => {
    // `web` is off for every profile but the reader's own, and the order is the point: a run that may not go
    // online is refused without this deployment consulting a setting or spending one of the route's slots.
    for (const profile of ['community', 'preview', 'dynamic', 'startup'] as CapabilityProfile[]) {
      const relay = relayWith(() => envelope('{}'), false)
      const host = hostOver(relay.deps, profile)
      expect(refused(await ask(host, 'web.request', [{ url: TARGET }])), profile)
        .toEqual({ code: 'capability-blocked', detail: 'web.request' })
      expect(relay.switchReads, profile).toBe(0)
      expect(relay.urls, profile).toEqual([])
    }
  })

  it('refuses a run the page never registered, and a name it does not answer', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const relay = relayWith(() => envelope('{}'))
    const host = hostOver(relay.deps)
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }], 'run-elsewhere')))
      .toEqual({ code: 'render-failed', detail: 'run:run-elsewhere' })
    // An unowned name here is a routing bug in this app, so it is said on the console and answered with the
    // generic code — `prompt-host.ts` makes the same choice for the same reason.
    expect(refused(await ask(host, 'system.prompt', [{}]))).toEqual({ code: 'render-failed', detail: 'web-host:system.prompt' })
    expect(logged).toHaveBeenCalledWith('[inkstone] templater web host asked about a method it does not own', 'system.prompt')
    expect(relay.urls).toEqual([])
  })

  it('stops answering a run the page has released', async () => {
    const relay = relayWith(() => envelope('[{"quote":"q","author":"a"}]'))
    const host = hostOver(relay.deps)
    expect(answered(await ask(host, 'web.dailyQuote', ['en']))).toEqual({ quote: 'q', author: 'a' })
    host.endRun('run-1')
    expect(host.liveRuns()).toBe(0)
    expect(refused(await ask(host, 'web.dailyQuote', ['en']))).toEqual({ code: 'render-failed', detail: 'run:run-1' })
    // Two calls, one released: the second never reached the door.
    expect(relay.urls).toHaveLength(1)
  })
})

describe('what a web failure may carry', () => {
  it('never puts a response body into a log line or into a detail', async () => {
    const BODY = 'the paragraph the template fetched'
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = hostOver({ webRequestsEnabled: () => true })

    // Every path that has something to say about a failure: a non-2xx carrying prose, a 200 that is not the
    // contract, a route refusal whose message is prose, a lost network, and a relay that threw.
    const failures: { code: string; detail: string | undefined }[] = []
    stubFetch(() => new Response(JSON.stringify({ status: 200, ok: true, contentType: 'application/json', text: BODY }), { status: 500 }))
    failures.push(refused(await ask(host, 'web.request', [{ url: TARGET }])))
    stubFetch(() => new Response(BODY, { status: 200 }))
    failures.push(refused(await ask(host, 'web.request', [{ url: TARGET }])))
    stubFetch(() => routeRefusal(403, 'web-blocked', BODY))
    failures.push(refused(await ask(host, 'web.request', [{ url: TARGET }])))
    stubFetch(() => new TypeError('Failed to fetch'))
    failures.push(refused(await ask(host, 'web.request', [{ url: TARGET }])))
    const throwing = hostOver({ webRequestsEnabled: () => true, fetchViaProxy: async () => { throw new Error('the relay is gone') } })
    failures.push(refused(await ask(throwing, 'web.request', [{ url: TARGET }])))

    for (const failure of failures) expect(failure.detail).not.toContain(BODY)
    const lines = [...logged.mock.calls, ...warned.mock.calls]
      .map((args) => args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(' '))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain(BODY)
  })

  it('keeps a refusal to its name wherever the table has a sentence for it', async () => {
    // The route's `message` is this deployment's English and is used nowhere on this path: a code the error
    // table knows gets that code as its detail, and the interface says the rest in the reader's language.
    stubFetch(() => routeRefusal(403, 'web-blocked', 'The address the template asked for is not allowed'))
    const host = hostOver({ webRequestsEnabled: () => true })
    expect(refused(await ask(host, 'web.request', [{ url: TARGET }])).detail).toBe('web-blocked')
    expect(refused(await ask(host, 'web.dailyQuote', ['en'])).detail).toBe('web-blocked')
    expect(refused(await ask(host, 'web.randomPicture', [null])).detail).toBe('web-blocked')
  })
})
