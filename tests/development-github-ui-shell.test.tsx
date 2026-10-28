// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { GithubApp } from '../src/client/features/development/github/GithubApp'
import { useGithubStore } from '../src/client/features/development/github/store'
import { clearGithubCache } from '../src/client/features/development/github/cache'

const repo = {
  id: 1,
  name: 'demo',
  fullName: 'octo/demo',
  url: 'https://github.com/octo/demo',
  description: 'A demo repository',
  homepage: null,
  owner: { login: 'octo', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
  language: 'TypeScript',
  stargazersCount: 12,
  forksCount: 3,
  openIssuesCount: 1,
  topics: ['demo'],
  license: 'MIT',
  isArchived: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-28T00:00:00Z',
  defaultBranch: 'main',
  size: 10,
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) {
      return response({
        ok: true,
        data: {
          tags: [],
          repos: [],
          gistTags: [],
          gists: [],
          mirrors: [{ id: 'gh-proxy', name: 'gh-proxy', url: 'https://gh-proxy.com', enabled: true, createdAt: 0 }],
          accounts: [],
          capabilities: { exports: true },
        },
      })
    }
    if (url.includes('/search')) return response({ ok: true, data: { total: 1, items: [repo] } })
    return response({ ok: true, data: {} })
  }))
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve()
  })
}

describe('GitHub module shell', () => {
  let rendered: RenderedElement | null = null

  beforeEach(async () => {
    await initI18n()
    clearGithubCache()
    useGithubStore.setState({
      status: 'idle',
      error: null,
      tags: [],
      repos: [],
      gistTags: [],
      gists: [],
      mirrors: [],
      accounts: [],
      capabilities: { exports: false },
    })
    mockFetch()
  })

  afterEach(() => {
    rendered?.unmount()
    rendered = null
    vi.unstubAllGlobals()
  })

  it('loads bootstrap and renders the repository list', async () => {
    rendered = renderElement(<GithubApp />)
    await settle()
    const text = rendered.container.textContent ?? ''
    expect(text).toContain(t('development.github.tabs.repos'))
    expect(text).toContain('octo/demo')
    expect(text).toContain('1 results')
  })

  it('switches to the Gist tab', async () => {
    rendered = renderElement(<GithubApp />)
    await settle()
    const gistTab = Array.from(rendered.container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((button) =>
      (button.textContent ?? '').includes(t('development.github.tabs.gists')))
    expect(gistTab).toBeTruthy()
    act(() => gistTab!.click())
    await settle()
    expect(rendered.container.textContent ?? '').toContain(t('development.github.gists.empty'))
    expect(rendered.container.textContent ?? '').toContain(t('development.github.gists.create'))
  })
})
