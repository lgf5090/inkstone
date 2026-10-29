import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { YouTubeQuotaData } from '@shared/youtube/model'
import { initI18n, t } from '../../../lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../../../lib/test-render'
import { formatNumber } from '../../../lib/time'
import { useYoutubeStore } from '../store'
import { QuotaDialog } from './QuotaDialog'
import { fetchQuota } from '../api'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchQuota: vi.fn() }
})

const COSTS = {
  search: 100,
  videos: 1,
  channels: 1,
  playlists: 1,
  playlistItems: 1,
  commentThreads: 1,
}

function quota(overrides: Partial<YouTubeQuotaData> = {}): YouTubeQuotaData {
  return {
    configured: true,
    limit: 10_000,
    today: {
      date: '2026-05-10',
      total: 2_500,
      remaining: 7_500,
      breakdown: [{ endpoint: 'search', units: 2_500, count: 25, cost: 100 }],
    },
    history: [
      { date: '2026-05-04', units: 0, count: 0 },
      { date: '2026-05-05', units: 300, count: 30 },
      { date: '2026-05-06', units: 100, count: 1 },
      { date: '2026-05-07', units: 0, count: 0 },
      { date: '2026-05-08', units: 1_000, count: 10 },
      { date: '2026-05-09', units: 500, count: 5 },
      { date: '2026-05-10', units: 2_500, count: 25 },
    ],
    weekBreakdown: [
      { endpoint: 'search', units: 2_500, count: 25, cost: 100 },
      { endpoint: 'videos', units: 40, count: 40, cost: 1 },
    ],
    quotaCosts: COSTS,
    ...overrides,
  }
}

let rendered: RenderedElement | null = null

beforeAll(async () => {
  installTestGlobals()
  await initI18n()
})

beforeEach(() => {
  useYoutubeStore.setState({
    library: { tags: [], videos: [], channels: [], playlists: [], truncated: false },
    libraryStatus: 'ready',
    libraryError: null,
    pending: [],
  })
  vi.mocked(fetchQuota).mockReset()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  document.body.innerHTML = ''
})

/** The dialog loads in an effect, so the first paint's promise needs a turn to settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label,
  )
  expect(found, `button "${label}" is not rendered`).toBeTruthy()
  return found as HTMLButtonElement
}

describe('QuotaDialog', () => {
  it('explains a deployment with no API key instead of showing zero usage', async () => {
    vi.mocked(fetchQuota).mockResolvedValue(quota({ configured: false }))
    rendered = renderElement(<QuotaDialog open onClose={() => {}} />)
    await settle()

    expect(document.body.textContent).toContain(t('youtube.quota.not_configured'))
    expect(document.body.textContent).toContain(t('youtube.quota.not_configured_desc'))
    expect(document.body.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('renders today, remaining units and the endpoint cost table', async () => {
    vi.mocked(fetchQuota).mockResolvedValue(quota())
    rendered = renderElement(<QuotaDialog open onClose={() => {}} />)
    await settle()

    const today = quota().today
    expect(document.body.textContent).toContain(formatNumber(today.total))
    expect(document.body.textContent).toContain(
      t('youtube.quota.remaining', { count: formatNumber(today.remaining) }),
    )
    expect(document.body.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25')

    const table = document.body.querySelector('table')
    expect(table, 'the cost table is not rendered').toBeTruthy()
    const row = [...table!.querySelectorAll('tbody tr')].find((entry) =>
      entry.textContent?.includes(t('youtube.endpoint.search')),
    )
    expect(row, 'the search cost row is not rendered').toBeTruthy()
    expect(row!.textContent).toContain(formatNumber(COSTS.search))
    expect(row!.textContent).toContain(
      t('youtube.quota.available', { count: formatNumber(10_000 / COSTS.search) }),
    )
  })

  it('shows the failure reason and retries the request', async () => {
    vi.mocked(fetchQuota)
      .mockRejectedValueOnce(new Error('upstream exploded'))
      .mockResolvedValueOnce(quota({ configured: false }))
    rendered = renderElement(<QuotaDialog open onClose={() => {}} />)
    await settle()

    expect(document.body.textContent).toContain('upstream exploded')

    const retry = button(t('youtube.retry'))
    await act(async () => {
      retry.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(vi.mocked(fetchQuota)).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain(t('youtube.quota.not_configured'))
  })
})
