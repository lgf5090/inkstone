// @vitest-environment jsdom
/**
 * The two surfaces that read the request log: the log itself and the statistics behind it.
 *
 * These cases pin what the screens claim rather than how they paint: the filters the worker supports are
 * the filters on screen, a filtered page shows its total and its rows, and the statistics name their
 * dimensions and their numbers. A chart is not drawn here — the canvas is stubbed, because the claim is
 * that the numbers reached the panel, not that chart.js can paint in jsdom.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantRequestLog } from '@shared/assistant'
import { initI18n, t } from '../../lib/i18n'
import { installTestGlobals } from '../../lib/test-render'
import { api } from '../../lib/api'
import { RequestLogsView } from './RequestLogsView'
import { RequestStatsView } from './RequestStatsView'
import { csvCell, toCsv } from './request-log-shared'

vi.mock('../../components/chart-canvas', () => ({
  ChartCanvas: () => createElement('div', { 'data-chart': '1' }),
  withAlpha: () => '#000000',
}))

let root: Root
let host: HTMLDivElement

function entry(over: Partial<AssistantRequestLog> = {}): AssistantRequestLog {
  return {
    id: 'log-1', at: Date.now(), providerId: 'p1', providerLabel: 'Example', keyId: 'k1',
    keyLabel: 'second', keyHint: '4321', modelLabel: 'example-model', modelId: 'example-model',
    operation: 'chat', ok: true, httpStatus: 200, errorKind: null, errorMessage: null,
    inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, latencyMs: 240, requestBody: null,
    conversationId: 'c1', attempt: 1, note: '', starred: false, ...over,
  }
}

async function show(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => { root.render(element) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.spyOn(api.assistant, 'logFacets').mockResolvedValue({
    providers: [{ id: 'p1', label: 'Example' }],
    keys: [{ id: 'k1', label: 'second', providerId: 'p1', keyHint: '4321' }],
    models: ['example-model'], operations: ['chat'], errorKinds: ['auth'],
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('the request log screen', () => {
  it('offers the filters the worker supports and shows a page with its total', async () => {
    const requestLogs = vi.spyOn(api.assistant, 'requestLogs').mockResolvedValue({
      logs: [entry(), entry({ id: 'log-2', ok: false, errorKind: 'auth', errorMessage: 'refused', attempt: 2 })],
      total: 2, page: 1, pageSize: 25,
    })
    await show(createElement(RequestLogsView))

    expect(requestLogs).toHaveBeenCalled()
    const text = document.body.textContent ?? ''
    expect(text).toContain(t('assistant.logs.title'))
    expect(text).toContain(t('assistant.logs.total', { count: '2' }))
    expect(text).toContain(t('assistant.logs.window_1h'))
    expect(text).toContain(t('assistant.insights.export_json'))
    expect(text).toContain(t('assistant.insights.export_csv'))
    expect(text).toContain(t('assistant.logs.cleanup'))
    expect(document.body.textContent).toContain('example-model')
    expect(document.body.textContent).toContain('auth')
  })

  it('says the list is empty instead of drawing nothing', async () => {
    vi.spyOn(api.assistant, 'requestLogs').mockResolvedValue({ logs: [], total: 0, page: 1, pageSize: 25 })
    await show(createElement(RequestLogsView))
    expect(document.body.textContent).toContain(t('assistant.logs.empty'))
  })

  it('sorts from a column header and offers a row menu on right click', async () => {
    const requestLogs = vi.spyOn(api.assistant, 'requestLogs').mockResolvedValue({
      logs: [entry()], total: 1, page: 1, pageSize: 25,
    })
    await show(createElement(RequestLogsView))

    const header = [...document.body.querySelectorAll<HTMLElement>('[role="columnheader"]')]
      .find((node) => node.textContent?.includes(t('assistant.logs.columns.latency')))
    expect(header, 'the latency column is not sortable').toBeTruthy()
    await act(async () => { header!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(requestLogs.mock.calls.some(([query]) => query.sortBy === 'latency' && query.sortDir === 'desc')).toBe(true)

    const row = document.body.querySelector('li[role="row"]')
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
    })
    expect(document.body.textContent).toContain(t('assistant.logs.copy_id'))
    expect(document.body.textContent).toContain(t('assistant.logs.filter_by_provider'))
  })

  it('asks for the chosen status and window rather than filtering on the client', async () => {
    const requestLogs = vi.spyOn(api.assistant, 'requestLogs').mockResolvedValue({ logs: [], total: 0, page: 1, pageSize: 25 })
    await show(createElement(RequestLogsView))
    const window = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === t('assistant.logs.window_24h'))
    expect(window).toBeTruthy()
    await act(async () => { window!.click() })
    expect(requestLogs.mock.calls.some(([query]) => query.sinceMs === 86_400_000)).toBe(true)
  })
})

describe('the request statistics screen', () => {
  it('names every dimension and renders the totals it was given', async () => {
    const requestStats = vi.spyOn(api.assistant, 'requestStats').mockResolvedValue({
      summary: {
        requests: 4, succeeded: 3, failed: 1, successRate: 0.75, inputTokens: 1_200, outputTokens: 400,
        cachedInputTokens: 100, avgLatencyMs: 210, p95LatencyMs: 480, lastAt: Date.now(),
      },
      series: [{ at: Date.now(), requests: 4, failed: 1, inputTokens: 1_200, outputTokens: 400, avgLatencyMs: 210 }],
      breakdown: [
        { id: 'p1', label: 'p1', requests: 3, succeeded: 3, failed: 0, inputTokens: 900, outputTokens: 300, avgLatencyMs: 180 },
        { id: 'p2', label: 'p2', requests: 1, succeeded: 0, failed: 1, inputTokens: 300, outputTokens: 100, avgLatencyMs: 300 },
      ],
    })
    await show(createElement(RequestStatsView))

    expect(requestStats.mock.calls[0]?.[1]).toBe('provider')
    const text = document.body.textContent ?? ''
    expect(text).toContain(t('assistant.stats.request_title'))
    expect(text).toContain('75%')
    expect(text).toContain(t('assistant.stats.dim_key'))
    expect(text).toContain(t('assistant.stats.dim_day'))
    expect(text).toContain(t('assistant.stats.breakdown'))
    expect(text).toContain('Example')
    expect(document.body.querySelector('[data-chart="1"]')).toBeTruthy()
  })

  it('asks for another dimension when the reader picks one', async () => {
    const requestStats = vi.spyOn(api.assistant, 'requestStats').mockResolvedValue({
      summary: {
        requests: 0, succeeded: 0, failed: 0, successRate: 0, inputTokens: 0, outputTokens: 0,
        cachedInputTokens: 0, avgLatencyMs: null, p95LatencyMs: null, lastAt: null,
      },
      series: [], breakdown: [],
    })
    await show(createElement(RequestStatsView))
    const byModel = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === t('assistant.stats.dim_model'))
    expect(byModel).toBeTruthy()
    await act(async () => { byModel!.click() })
    expect(requestStats.mock.calls.some(([, dimension]) => dimension === 'model')).toBe(true)
    expect(document.body.textContent).toContain(t('assistant.stats.request_empty'))
  })
})

describe('a downloaded log file', () => {
  it('neutralises a spreadsheet formula written by an upstream error', () => {
    const csv = toCsv([entry({
      note: '=HYPERLINK("http://attacker.example","open")',
      errorMessage: '+cmd|calc',
    })], false)
    expect(csv).toContain("'=HYPERLINK")
    expect(csv).toContain("'+cmd|calc")
    expect(csv).not.toMatch(/,\+cmd\|calc/)
  })

  it('keeps a negative number numeric while neutralising a string that looks like one', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('-5')).toBe("'-5")
  })
})
