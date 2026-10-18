// @vitest-environment jsdom
/**
 * The two bulk transfers, and what a refusal on one of them says.
 *
 * Both of these own their transport instead of going through `request()`: an upload reports bytes as they
 * leave (`fetch` reports nothing while the body is going out), and a download reports bytes as they arrive.
 * That is why both were left building their own error — each took the route's `message` as its whole
 * headline and fell back to a bare status code. Two things follow from that. A composer holding four
 * attachments and one refusal could not say which chip to pull, because the status never named a file. And
 * the route's own sentence went onto the screen raw: unbounded, unflattened, and with whatever credential
 * it echoed still in it, because only `routeApiError()` applies that policy.
 *
 * So the contract pinned here is the one the rest of the client already has: the transfer's own line stays
 * the headline and names what it was about, the route's reason arrives beside it through the factory, and
 * a route that said nothing leaves exactly the line these two paths have always said — one line, no empty
 * reason hanging off the end of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { ApiError, api } from './api'
import { initI18n, t } from './i18n'
import { installTestGlobals, renderElement, type RenderedElement } from './test-render'
import { Toaster } from '../components/feedback'
import { useUi } from '../store/ui'

/** A transport that answers whatever the case says, and hands the case the socket it wrote back on. */
class FakeXhr {
  static opened: FakeXhr[] = []
  status = 0
  responseText = ''
  responseType = ''
  url = ''
  sent: FormData | null = null
  upload: { onprogress: ((event: { loaded: number, total: number, lengthComputable: boolean }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null

  open(_method: string, url: string): void {
    this.url = url
    FakeXhr.opened.push(this)
  }
  setRequestHeader(): void {}
  send(body: FormData): void { this.sent = body }
  abort(): void { this.onabort?.() }

  /** The answer a browser would deliver: status and body, then the load handler. */
  respond(status: number, body: string): void {
    this.status = status
    this.responseText = body
    this.onload?.()
  }

  static last(): FakeXhr {
    const xhr = FakeXhr.opened.at(-1)
    if (!xhr) throw new Error('the upload never opened a request')
    return xhr
  }
}

/** A file the composer accepted; the name is what the headline has to keep. */
const REPORT = new File(['a'.repeat(10)], 'quarterly report.pdf', { type: 'application/pdf' })

const refusalBody = {
  error: {
    code: 'payload_too_large',
    message: 'The file is 3 MB over the per-file ceiling.',
    details: { limit_bytes: 20_000_000, received_bytes: 23_000_000 },
  },
}

let rendered: RenderedElement | null = null

/** Runs the real download against a stubbed fetch and hands back whatever it threw. */
async function download(body: unknown, status: number): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { 'content-type': 'application/json' },
  })))
  try {
    await api.assistant.downloadChatFile('f1', () => undefined)
  } catch (error) {
    return error
  }
  throw new Error('a refused download that did not throw is the bug, not the case')
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  FakeXhr.opened = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('a refused upload', () => {
  it('names the file and carries the reason the route gave', async () => {
    const attempt = api.assistant.uploadChatFile(REPORT, () => undefined)
    FakeXhr.last().respond(413, JSON.stringify(refusalBody))
    const error = await attempt.then(() => null, (caught: unknown) => caught)

    expect(error, 'an upload refusal is not an ApiError, so no surface can find its detail line')
      .toBeInstanceOf(ApiError)
    const failure = error as ApiError
    expect(failure.status).toBe(413)
    expect(failure.code).toBe('payload_too_large')
    expect(failure.message).toContain('413')
    expect(failure.message).toContain(REPORT.name)
    expect(failure.serverMessage).toContain('3 MB over the per-file ceiling')
    expect(failure.serverMessage).toContain('limit_bytes')
    // The route's sentence is a detail under the headline, never the headline itself.
    expect(failure.serverMessage).not.toBe(failure.message)
  })

  it('flattens and bounds what the route said, because it is another process’s writing', async () => {
    const attempt = api.assistant.uploadChatFile(REPORT, () => undefined)
    FakeXhr.last().respond(400, JSON.stringify({
      error: {
        code: 'bad_request',
        message: `bad\n\t<img src=x onerror=boom()>${'noise '.repeat(200)}`,
      },
    }))
    const failure = await attempt.then(() => null, (caught: unknown) => caught) as ApiError

    const line = failure.serverMessage ?? ''
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\t')
    expect(line.length).toBeLessThanOrEqual(240)
    // Kept as the characters they are: the line quotes the route, it is not markup to interpret.
    expect(line).toContain('<img src=x onerror=boom()>')
  })

  it('keeps a credential the route echoed out of the upload’s own line', async () => {
    const attempt = api.assistant.uploadChatFile(REPORT, () => undefined)
    FakeXhr.last().respond(400, JSON.stringify({
      error: {
        code: 'bad_request',
        message: 'The key sk-abcdef1234567890abcdef was rejected',
        details: { apiKey: 'supersecretvalue12345' },
      },
    }))
    const failure = await attempt.then(() => null, (caught: unknown) => caught) as ApiError

    expect(failure.serverMessage).not.toContain('sk-abcdef1234567890abcdef')
    expect(failure.serverMessage).not.toContain('supersecretvalue12345')
    expect(failure.serverMessage).toContain('[redacted]')
    expect(failure.serverMessage).toContain('was rejected')
    // The headline used to be the route's sentence: no surface that prints only it may still see the key.
    expect(failure.message).not.toContain('sk-abcdef1234567890abcdef')
    expect(failure.message).not.toContain('supersecretvalue12345')
    expect(failure.message).toContain('400')
  })

  it('prints that reason as text in the notice the reader actually sees', async () => {
    const attempt = api.assistant.uploadChatFile(REPORT, () => undefined)
    FakeXhr.last().respond(400, JSON.stringify({
      error: { code: 'bad_request', message: 'The name <img src=x onerror=boom()> was refused' },
    }))
    const failure = await attempt.then(() => null, (caught: unknown) => caught) as ApiError

    useUi.getState().toast({ title: t('assistant.attach.failed'), description: failure.serverMessage, tone: 'danger' })
    rendered = renderElement(createElement(Toaster))
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('The name <img src=x onerror=boom()> was refused')
    expect(document.querySelectorAll('img, script')).toHaveLength(0)
  })

  it('stays the single line it has always been when the route answered with no body', async () => {
    const attempt = api.assistant.uploadChatFile(REPORT, () => undefined)
    FakeXhr.last().respond(413, '')
    const failure = await attempt.then(() => null, (caught: unknown) => caught) as ApiError

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure.message).toBe(`Upload failed (413): ${REPORT.name}`)
    // Nothing invented, and no empty detail hanging off the line: `describeFailure` has to see no second half.
    expect(failure.serverMessage ?? null).toBeNull()
    expect(failure.message).not.toContain(' — ')
  })

  it('still resolves the attachment the route accepted', async () => {
    const attempt = api.assistant.uploadChatFile(REPORT, () => undefined)
    FakeXhr.last().respond(200, JSON.stringify({
      attachment: { id: 'f1', filename: REPORT.name, mime: REPORT.type, size: 10, kind: 'document' },
    }))
    const stored = await attempt

    expect(stored).toMatchObject({ id: 'f1' })
    expect(FakeXhr.last().sent?.get('file')).toBeInstanceOf(File)
  })
})

describe('a refused download', () => {
  it('carries the reason the route gave beside the transfer’s own line', async () => {
    const error = await download({
      error: {
        code: 'not_found',
        message: 'The stored file was pruned with the shelf it sat on.',
        details: { id: 'f1' },
      },
    }, 404)

    expect(error, 'a download refusal is not an ApiError, so no surface can find its detail line')
      .toBeInstanceOf(ApiError)
    const failure = error as ApiError
    expect(failure.status).toBe(404)
    expect(failure.code).toBe('not_found')
    expect(failure.message).toBe('Download failed (404)')
    expect(failure.serverMessage).toContain('pruned with the shelf')
    expect(failure.serverMessage).toContain('id')
  })

  it('stays the single line it has always been when the route answered with no body', async () => {
    const failure = await download(null, 500) as ApiError

    expect(failure).toBeInstanceOf(ApiError)
    expect(failure.message).toBe('Download failed (500)')
    expect(failure.serverMessage ?? null).toBeNull()
  })

  it('reads the bytes back when the file is there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('the document', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })))
    const blob = await api.assistant.downloadChatFile('f1', () => undefined)
    expect(await blob.text()).toBe('the document')
  })
})
