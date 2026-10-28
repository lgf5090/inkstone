import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GithubSearchParams } from '@shared/development/github/types'
import { clearGithubCache, useGithubSearch } from '../src/client/features/development/github/cache'
import { renderElement } from '../src/client/lib/test-render'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function envelope(data: unknown): Response {
  return json({ ok: true, data })
}

const PARAMS: GithubSearchParams = {
  q: 'react',
  range: 'today',
  sort: 'stars',
  order: 'desc',
  language: '',
  perPage: 25,
  page: 1,
}

async function waitForText(view: ReturnType<typeof renderElement>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (view.container.textContent?.includes(text)) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  expect(view.container.textContent).toContain(text)
}

function Host({ params }: { params: GithubSearchParams }) {
  const query = useGithubSearch(params)
  return createElement('div', null, [
    createElement('span', { key: 'loading' }, query.loading ? 'loading' : 'idle'),
    createElement('span', { key: 'total' }, query.data ? String(query.data.total) : '-'),
    createElement('span', { key: 'error' }, query.error?.message ?? ''),
  ])
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  clearGithubCache()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GitHub query cache', () => {
  it('loads once and reuses the cached page for identical parameters', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ total: 1, items: [] }))
    const view = renderElement(createElement(Host, { params: PARAMS }))
    await waitForText(view, '1')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    view.rerender(createElement(Host, { params: { ...PARAMS } }))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    view.unmount()
  })

  it('treats every search parameter as part of the key', async () => {
    fetchMock.mockResolvedValueOnce(envelope({ total: 1, items: [] }))
    const view = renderElement(createElement(Host, { params: PARAMS }))
    await waitForText(view, '1')

    fetchMock.mockResolvedValueOnce(envelope({ total: 2, items: [] }))
    view.rerender(createElement(Host, { params: { ...PARAMS, language: 'Rust' } }))
    await waitForText(view, '2')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(envelope({ total: 3, items: [] }))
    view.rerender(createElement(Host, { params: { ...PARAMS, page: 2 } }))
    await waitForText(view, '3')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    view.unmount()
  })

  it('aborts the in-flight request when the hook unmounts', async () => {
    let resolveFetch: (value: Response) => void = () => undefined
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    })
    const view = renderElement(createElement(Host, { params: PARAMS }))
    await act(async () => {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    })
    expect(signal?.aborted).toBe(false)
    view.unmount()
    expect(signal?.aborted).toBe(true)
    await act(async () => {
      resolveFetch(envelope({ total: 1, items: [] }))
      await Promise.resolve()
    })
  })
})
