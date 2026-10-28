// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { XgetSettings, XgetStatsSummary } from '../src/shared/development/xget/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { ConverterBar } from '../src/client/features/development/xget/components/ConverterBar'
import { SettingsPanel } from '../src/client/features/development/xget/components/SettingsPanel'
import { StatsView } from '../src/client/features/development/xget/components/StatsView'
import type { XgetHistoryItem } from '../src/client/features/development/xget/lib/history'

const apiMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  setToken: vi.fn(),
  testTarget: vi.fn(),
  getStats: vi.fn(),
}))

vi.mock('../src/client/features/development/xget/api', () => ({
  xgetApi: apiMocks,
  describeXgetError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

vi.mock('../src/client/components/chart-canvas', () => ({
  ChartCanvas: () => null,
}))

const SETTINGS: XgetSettings = {
  proxy_base_url: 'https://inkstone.test/api/development/xget',
  platform_count: 84,
  has_proxy_token: false,
  can_manage: true,
  config: {
    timeout_seconds: 30,
    max_retries: 3,
    retry_delay_ms: 1000,
    cache_duration: 300,
    allowed_methods: ['GET', 'HEAD'],
    allowed_origins: ['*'],
    max_path_length: 2048,
  },
}

const SUMMARY: XgetStatsSummary = {
  total: 12,
  ok: 11,
  okRate: 91.7,
  today: 2,
  platformCount: 1,
  platforms: [{ platform: 'gh', count: 8, ok: 8, pct: 66.7 }],
  trend: [
    { day: '2026-10-01', count: 5, ok: 5 },
    { day: '2026-10-02', count: 7, ok: 6 },
  ],
  trendByCategory: [
    { day: '2026-10-01', code: 5, package: 0, linux: 0, misc: 0, ai: 0, registry: 0 },
    { day: '2026-10-02', code: 7, package: 0, linux: 0, misc: 0, ai: 0, registry: 0 },
  ],
}

let rendered: RenderedElement | null = null

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.includes(label))
  if (!found) throw new Error(`missing button ${label}`)
  return found as HTMLButtonElement
}

function setInput(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setValue?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function Harness({
  initial,
  proxyBase,
  history,
}: {
  initial: string
  proxyBase: string
  history: XgetHistoryItem[]
}) {
  const [input, setInput] = useState(initial)
  const [signal, setSignal] = useState(0)
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setInput('https://github.com/a/b/archive/refs/heads/main.zip')
          setSignal((value) => value + 1)
        }}
      >
        reuse
      </button>
      <ConverterBar
        proxyBase={proxyBase}
        input={input}
        onInputChange={setInput}
        convertSignal={signal}
        onHistory={(item) => history.push(item)}
      />
    </div>
  )
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  vi.clearAllMocks()
  apiMocks.getStats.mockResolvedValue(SUMMARY)
  apiMocks.saveSettings.mockResolvedValue({ config: SETTINGS.config })
  apiMocks.setToken.mockResolvedValue({ has_proxy_token: true })
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the Xget converter', () => {
  it('converts the example and records that exact result, not the previous input', () => {
    const history: XgetHistoryItem[] = []
    rendered = renderElement(<Harness initial="https://example.com/nothing" proxyBase={SETTINGS.proxy_base_url} history={history} />)
    act(() => button(rendered!.container, t('development.xget.converter.paste_example')).click())
    expect(rendered.container.textContent).toContain('https://inkstone.test/api/development/xget/gh/microsoft/vscode/archive/refs/heads/main.zip')
    expect(history.at(-1)?.result).toContain('/gh/microsoft/vscode/archive/refs/heads/main.zip')
  })

  it('reuses a history item with the value it names', () => {
    const history: XgetHistoryItem[] = []
    rendered = renderElement(<Harness initial="https://example.com/nothing" proxyBase={SETTINGS.proxy_base_url} history={history} />)
    act(() => button(rendered!.container, 'reuse').click())
    expect(rendered.container.textContent).toContain('/gh/a/b/archive/refs/heads/main.zip')
    expect(history.at(-1)?.url).toBe('https://github.com/a/b/archive/refs/heads/main.zip')
  })

  it('recomputes when the settings base URL arrives after the input', () => {
    vi.useFakeTimers()
    const history: XgetHistoryItem[] = []
    const tree = (proxyBase: string) => <Harness initial="https://github.com/a/b/archive/main.zip" proxyBase={proxyBase} history={history} />
    rendered = renderElement(tree(''))
    expect(rendered.container.textContent).not.toContain('/gh/a/b/archive/main.zip')
    rendered.rerender(tree('https://late.test/api/development/xget'))
    act(() => vi.advanceTimersByTime(260))
    expect(rendered.container.textContent).toContain('https://late.test/api/development/xget/gh/a/b/archive/main.zip')
  })

  it('debounces detection and opens the converted URL with noopener', () => {
    vi.useFakeTimers()
    const history: XgetHistoryItem[] = []
    rendered = renderElement(<Harness initial="https://github.com/a/b/archive/main.zip" proxyBase={SETTINGS.proxy_base_url} history={history} />)
    act(() => vi.advanceTimersByTime(260))
    expect(rendered.container.textContent).toContain('/gh/a/b/archive/main.zip')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    act(() => button(rendered!.container, t('development.xget.converter.open')).click())
    expect(open).toHaveBeenCalledWith(
      'https://inkstone.test/api/development/xget/gh/a/b/archive/main.zip',
      '_blank',
      'noopener,noreferrer',
    )
    open.mockRestore()
  })
})

describe('the Xget settings panel', () => {
  it('saves the edited timeout and token', async () => {
    rendered = renderElement(
      <SettingsPanel settings={SETTINGS} loading={false} error={null} onReload={vi.fn(async () => undefined)} />,
    )
    const timeout = rendered.container.querySelector<HTMLInputElement>('input[type="number"]')!
    setInput(timeout, '5')
    act(() => button(rendered!.container, t('development.xget.settings.save')).click())
    await act(async () => {})
    expect(apiMocks.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ timeout_seconds: 5 }))

    const token = rendered.container.querySelector<HTMLInputElement>('input[type="password"]')!
    setInput(token, 'token-12345678')
    const saves = [...rendered.container.querySelectorAll('button')].filter((entry) => entry.textContent?.includes(t('development.xget.settings.save')))
    act(() => saves.at(-1)!.click())
    await act(async () => {})
    expect(apiMocks.setToken).toHaveBeenCalledWith('token-12345678')
  })

  it('does not let a member save', () => {
    rendered = renderElement(
      <SettingsPanel settings={{ ...SETTINGS, can_manage: false }} loading={false} error={null} onReload={vi.fn(async () => undefined)} />,
    )
    const save = button(rendered.container, t('development.xget.settings.save'))
    expect(save.disabled).toBe(true)
    expect(rendered.container.textContent).toContain(t('development.xget.settings.owner_only'))
  })
})

describe('the Xget stats view', () => {
  it('renders the summary and requests the range that was clicked', async () => {
    rendered = renderElement(<StatsView />)
    await act(async () => {})
    expect(rendered.container.textContent).toContain('12')
    expect(rendered.container.textContent).toContain('91.7%')
    expect(rendered.container.textContent).toContain('GitHub')

    act(() => button(rendered!.container, t('development.xget.stats.range30')).click())
    await act(async () => {})
    expect(apiMocks.getStats).toHaveBeenLastCalledWith(30)
  })
})
