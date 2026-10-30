// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HttpRequestConfig,
  RequestKind,
  ResponseResult,
  TestResult,
} from '../src/shared/development/api-tester/types'
import { defaultRequest } from '../src/shared/development/api-tester/state'
import { initI18n, t } from '../src/client/lib/i18n'
import { renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { useUi } from '../src/client/store/ui'
import { ResponsePanel } from '../src/client/features/development/api-tester/components/ResponsePanel'
import { CodeBlock } from '../src/client/features/development/api-tester/components/CodeBlock'

const apiMock = vi.hoisted(() => ({
  uploadText: vi.fn(),
  uploadFile: vi.fn(),
}))

const prismMock = vi.hoisted(() => ({
  highlightWithPrism: vi.fn(),
}))

vi.mock('../src/client/features/development/api-tester/api', () => ({
  uploadText: apiMock.uploadText,
  uploadFile: apiMock.uploadFile,
  sendProxy: vi.fn(),
}))

vi.mock('../src/client/lib/markdown/prism', () => ({
  highlightWithPrism: prismMock.highlightWithPrism,
}))

const request: HttpRequestConfig = {
  ...defaultRequest(),
  method: 'GET',
  url: 'https://api.example.com/users',
}

function response(overrides: Partial<ResponseResult> = {}): ResponseResult {
  return {
    status: 200,
    statusText: 'OK',
    headers: [],
    contentType: 'application/json',
    sizeBytes: 2,
    durationMs: 12,
    body: '{}',
    bodyB64: null,
    redirected: false,
    url: 'https://api.example.com/users',
    cookies: [],
    timing: { totalMs: 12 },
    ...overrides,
  }
}

function renderPanel(
  result: ResponseResult | null,
  options: {
    loading?: boolean
    request?: HttpRequestConfig | null
    kind?: RequestKind
    testResults?: { results: TestResult[]; error?: string }
    autoPrettify?: boolean
  } = {},
): HTMLElement {
  rendered = renderElement(
    <ResponsePanel
      result={result}
      loading={options.loading ?? false}
      request={options.request === undefined ? request : options.request}
      kind={options.kind ?? 'rest'}
      testResults={options.testResults}
      autoPrettify={options.autoPrettify ?? true}
    />,
  )
  return rendered.container
}

let rendered: RenderedElement | null = null

function click(element: Element | null): void {
  if (!element) throw new Error('element is missing')
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function tab(container: HTMLElement, index: number): HTMLElement {
  const element = container.querySelectorAll<HTMLElement>('[role="tab"]')[index]
  if (!element) throw new Error(`tab ${index} is missing`)
  return element
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  ) ?? null
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('no HTMLInputElement value setter')
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  if (!setter) throw new Error('no HTMLSelectElement value setter')
  act(() => {
    setter.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function clearToasts(): void {
  for (const item of useUi.getState().toasts) useUi.getState().dismissToast(item.id)
}

beforeAll(async () => {
  await initI18n()
})

beforeEach(() => {
  apiMock.uploadText.mockResolvedValue({})
  apiMock.uploadFile.mockResolvedValue({})
  prismMock.highlightWithPrism.mockResolvedValue(null)
  clearToasts()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('ResponsePanel', () => {
  it('renders status, duration, size and a searchable JSON tree', () => {
    const container = renderPanel(
      response({
        status: 201,
        statusText: 'Created',
        body: '{"alpha":1,"beta":{"gamma":true}}',
        durationMs: 42,
        sizeBytes: 123,
      }),
    )

    expect(container.textContent).toContain('201 Created')
    expect(container.textContent).toContain('42 ms')
    expect(container.textContent).toContain('123 B')
    expect(container.textContent).toContain('$')
    expect(container.textContent).toContain('alpha')
    expect(container.querySelector('[data-mode="pretty"]')).not.toBeNull()
  })

  it('falls back to RAW for JSON when autoPrettify is off', () => {
    const container = renderPanel(response({ body: '{"alpha":1}' }), { autoPrettify: false })

    expect(container.querySelector('[data-mode="raw"]')).not.toBeNull()
    expect(container.querySelector('[data-mode="pretty"]')).toBeNull()
    expect(container.textContent).not.toContain('$')
  })

  it('shows the error label and error text when the relay reports an error', () => {
    const container = renderPanel(
      response({ status: 0, statusText: '', error: 'connect ECONNREFUSED' }),
    )

    expect(container.textContent).toContain(t('development.apitester.status_error'))
    expect(container.textContent).toContain('connect ECONNREFUSED')
  })

  it('renders loading and empty states', () => {
    const loadingContainer = renderPanel(null, { loading: true })
    expect(loadingContainer.textContent).toContain(t('development.apitester.waiting_response'))

    rendered?.unmount()
    const emptyContainer = renderPanel(null)
    expect(emptyContainer.textContent).toContain(t('development.apitester.click_send_to_start'))
    expect(emptyContainer.textContent).toContain(t('development.apitester.response_will_show_here'))
  })

  it('searches RAW output with next/previous match and case sensitivity', () => {
    const container = renderPanel(
      response({
        contentType: 'text/plain',
        body: 'alpha\nbeta error\ngamma error\ndelta',
      }),
      { autoPrettify: false },
    )

    const input = container.querySelector<HTMLInputElement>('input')
    if (!input) throw new Error('raw search input is missing')
    setInput(input, 'error')

    expect(container.textContent).toContain('1/2')
    expect(container.querySelectorAll('mark')).toHaveLength(2)
    expect(container.querySelectorAll('mark')[0]?.getAttribute('data-active')).toBe('true')

    click(container.querySelector(`[aria-label="${t('development.apitester.next_match')}"]`))
    expect(container.textContent).toContain('2/2')
    expect(container.querySelectorAll('mark')[1]?.getAttribute('data-active')).toBe('true')

    click(container.querySelector(`[aria-label="${t('development.apitester.prev_match')}"]`))
    expect(container.textContent).toContain('1/2')

    setInput(input, 'ERROR')
    expect(container.querySelectorAll('mark')).toHaveLength(2)
    click(container.querySelector(`[aria-label="${t('development.apitester.case_sensitive')}"]`))
    expect(container.textContent).toContain(t('development.apitester.no_match_found'))
    expect(container.querySelectorAll('mark')).toHaveLength(0)
  })

  it('lists response headers and cookie fields', () => {
    const container = renderPanel(
      response({
        headers: [
          { key: 'content-type', value: 'application/json' },
          { key: 'x-request-id', value: 'trace-1' },
        ],
        cookies: [{ name: 'sid', value: 'abc123', domain: '.example.com', path: '/' }],
      }),
    )

    click(tab(container, 1))
    expect(container.textContent).toContain('content-type')
    expect(container.textContent).toContain('application/json')
    expect(container.textContent).toContain('x-request-id')
    expect(container.textContent).toContain('trace-1')

    expect(container.textContent).toContain(t('development.apitester.cookies'))

    click(tab(container, 2))
    expect(container.textContent).toContain('sid')
    expect(container.textContent).toContain('abc123')
    expect(container.textContent).toContain('.example.com')
    expect(container.textContent).toContain('/')
    expect(container.textContent).toContain(t('development.apitester.cookie_domain'))
    expect(container.textContent).toContain(t('development.apitester.cookie_path'))
  })

  it('shows an unavailable notice for an image the relay refused to buffer', () => {
    const container = renderPanel(
      response({
        contentType: 'image/png',
        sizeBytes: 6 * 1024 * 1024,
        body: '',
        bodyB64: null,
        url: 'https://api.example.com/huge.png',
        error: 'response_too_large',
      }),
      { autoPrettify: false },
    )

    const preview = [...container.querySelectorAll('button')].find(
      (element) => (element.textContent ?? '').trim() === t('development.apitester.preview'),
    )
    if (!preview) throw new Error('preview toggle is missing')
    click(preview)

    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain(t('development.apitester.preview_unsupported'))
  })

  it('draws the timing waterfall with a dash for missing phases', () => {
    const container = renderPanel(
      response({
        durationMs: 52,
        timing: {
          dnsMs: 5,
          connectMs: 10,
          ttfbMs: 30,
          downloadMs: 7,
          totalMs: 52,
        },
      }),
    )

    click(tab(container, 3))
    expect(container.textContent).toContain('DNS')
    expect(container.textContent).toContain('Connect')
    expect(container.textContent).toContain('TLS')
    expect(container.textContent).toContain('TTFB')
    expect(container.textContent).toContain('Download')
    expect(container.textContent).toContain('5 ms')
    expect(container.textContent).toContain('7 ms')
    expect(container.textContent).toContain('—')
    expect(container.textContent).toContain(t('development.apitester.total_time', { ms: 52 }))
  })

  it('switches generated code languages and highlights through Prism', async () => {
    const container = renderPanel(response(), { request })
    click(tab(container, 4))

    const codeElement = container.querySelector<HTMLElement>('[data-slot="api-tester-code-block"] code')
    if (!codeElement) throw new Error('code block is missing')
    expect(codeElement.textContent).toContain('api.example.com/users')

    const select = container.querySelector('select') as HTMLSelectElement | null
    if (!select) throw new Error('language select is missing')
    await act(async () => {
      setSelect(select, 'python-requests')
      await Promise.resolve()
    })

    expect(codeElement.textContent).toContain('requests')
    expect(prismMock.highlightWithPrism).toHaveBeenCalledWith(
      expect.stringContaining('requests'),
      'python',
    )
  })

  it('shows test pass rate, total percentage and per-test errors', () => {
    const container = renderPanel(response(), {
      testResults: {
        results: [
          { name: 'status is 200', passed: true },
          { name: 'body has id', passed: true },
          { name: 'header exists', passed: false, error: 'expected X-Trace' },
        ],
      },
    })

    click(tab(container, 5))
    expect(container.textContent).toContain(
      t('development.apitester.tests_passed_count', { passed: 2, total: 3 }),
    )
    expect(container.textContent).toContain(
      t('development.apitester.failed_count', { count: 1 }),
    )
    expect(container.textContent).toContain(
      t('development.apitester.total_tests', { count: 3, pct: 67 }),
    )
    expect(container.textContent).toContain('expected X-Trace')
  })

  it('renders HTML preview in a fully sandboxed iframe with a CSP prefix', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body><script>alert(1)</script>ok</body></html>'
    const container = renderPanel(response({ contentType: 'text/html; charset=utf-8', body: html }))

    click(buttonByText(container, t('development.apitester.preview')))
    const iframe = container.querySelector('iframe')
    if (!iframe) throw new Error('preview iframe is missing')

    expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.getAttribute('srcdoc')).toContain(
      `content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'"`,
    )
    expect(iframe.getAttribute('srcdoc')).toContain(html)
  })

  it('previews base64 images from a data URL', () => {
    const container = renderPanel(
      response({ contentType: 'image/png', body: '', bodyB64: 'aGk=' }),
    )
    click(buttonByText(container, t('development.apitester.preview')))

    const image = container.querySelector('img')
    expect(image?.getAttribute('src')).toBe('data:image/png;base64,aGk=')
  })

  it('saves text responses to server files with the content-type kind', async () => {
    const body = '{"ok":true}'
    const container = renderPanel(
      response({ status: 200, contentType: 'application/json', body }),
    )

    const saveButton = container.querySelector(
      `[aria-label="${t('development.apitester.response.save_to_server')}"]`,
    )
    await act(async () => {
      click(saveButton)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(apiMock.uploadText).toHaveBeenCalledWith(
      body,
      'json',
      expect.stringMatching(/^response-200-\d+\.json$/),
      'application/json',
    )
    expect(useUi.getState().toasts.at(-1)?.title).toBe(
      t('development.apitester.response.saved_to_server'),
    )
  })

  it('reports a failed save instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    apiMock.uploadText.mockRejectedValueOnce(new Error('upload failed'))
    const container = renderPanel(response({ body: 'plain', contentType: 'text/plain' }))

    const saveButton = container.querySelector(
      `[aria-label="${t('development.apitester.response.save_to_server')}"]`,
    )
    await act(async () => {
      click(saveButton)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(apiMock.uploadFile).not.toHaveBeenCalled()
    expect(useUi.getState().toasts.at(-1)?.title).toBe(
      t('development.apitester.save_failed'),
    )
    expect(useUi.getState().toasts.at(-1)?.tone).toBe('danger')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('CodeBlock', () => {
  it('escapes source when highlighting has no result', () => {
    const view = renderElement(
      <CodeBlock code={'<img src=x onerror="alert(1)"><script>alert(1)</script>'} lang="html" />,
    )
    const code = view.container.querySelector('code')
    if (!code) throw new Error('code element is missing')

    expect(code.querySelector('script')).toBeNull()
    expect(code.innerHTML).toContain('&lt;script&gt;')
    expect(code.innerHTML).toContain('&lt;img')
    expect(prismMock.highlightWithPrism).toHaveBeenCalledWith(expect.any(String), 'markup')
    view.unmount()
  })
})
