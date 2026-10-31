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

const searchRequests: string[] = []

function mockFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/search')) searchRequests.push(url)
    if (url.includes('/repo-detail')) {
      return response({
        ok: true,
        data: {
          fullName: 'octo/demo',
          branchesCount: 1,
          branchesTruncated: false,
          defaultBranch: 'main',
          tagsCount: 0,
          tagsTruncated: false,
          languages: [],
          releases: [],
          releasesTruncated: false,
          readme: null,
          readmeHtmlUrl: null,
          warnings: [],
          rateLimited: false,
        },
      })
    }
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

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('GitHub module shell', () => {
  let rendered: RenderedElement | null = null

  beforeEach(async () => {
    await initI18n()
    clearGithubCache()
    searchRequests.length = 0
    useGithubStore.setState({
      status: 'idle',
      error: null,
      tags: [],
      repos: [],
      gistTags: [],
      gists: [],
      mirrors: [],
      accounts: [],
      activeAccountId: null,
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

  it('commits the typed query when the time range changes', async () => {
    rendered = renderElement(<GithubApp />)
    await settle()
    const input = rendered.container.querySelector<HTMLInputElement>(
      `input[aria-label="${t('development.github.repos.search')}"]`,
    )
    expect(input).toBeTruthy()
    typeInto(input!, 'react')
    const week = Array.from(rendered.container.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === t('development.github.repos.range.week'),
    )
    expect(week).toBeTruthy()
    act(() => week!.click())
    await settle()
    const last = searchRequests.at(-1) ?? ''
    expect(last).toContain('q=react')
    expect(last).toContain('range=week')
  })

  it('collapses and restores the detail pane in the two-pane layout', async () => {
    rendered = renderElement(<GithubApp />)
    await settle()
    const row = rendered.container.querySelector<HTMLElement>('[data-slot="github-repo-row"]')
    expect(row).toBeTruthy()
    act(() => row!.click())
    await settle()
    expect(rendered.container.querySelector('[data-slot="repo-detail"]')).not.toBeNull()
    const toggle = rendered.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${t('development.github.common.toggle_detail')}"]`,
    )
    expect(toggle).toBeTruthy()
    act(() => toggle!.click())
    await settle()
    expect(rendered.container.querySelector('[data-slot="repo-detail"]')).toBeNull()
    act(() => toggle!.click())
    await settle()
    expect(rendered.container.querySelector('[data-slot="repo-detail"]')).not.toBeNull()
  })

  it('exposes the open repository as a button instead of a listbox option', async () => {
    rendered = renderElement(<GithubApp />)
    await settle()
    const row = rendered.container.querySelector<HTMLElement>('[data-slot="github-repo-row"]')
    expect(row).toBeTruthy()
    act(() => row!.click())
    await settle()
    expect(rendered.container.querySelector('[role="listbox"]')).toBeNull()
    expect(row!.getAttribute('role')).toBeNull()
    expect(row!.querySelector('button[aria-current="true"]')).not.toBeNull()
  })
})
