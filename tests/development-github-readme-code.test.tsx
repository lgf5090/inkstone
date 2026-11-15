// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadmeBody } from '../src/client/features/development/github/components/ReadmeBody'
import { copyText } from '../src/client/lib/clipboard'
import { initI18n, t } from '../src/client/lib/i18n'
import { highlightWithPrism } from '../src/client/lib/markdown/prism'
import { installTestGlobals } from '../src/client/lib/test-render'
import { useUi } from '../src/client/store/ui'

vi.mock('../src/client/lib/markdown/prism', () => ({
  highlightWithPrism: vi.fn(async (source: string) => ({
    html: `<span class="token keyword">${source}</span>`,
    language: 'bash',
  })),
}))

vi.mock('../src/client/lib/clipboard', () => ({ copyText: vi.fn(async () => true) }))

let root: Root
let container: HTMLDivElement

function render(html: string): void {
  act(() => {
    root.render(createElement(StrictMode, null, createElement(ReadmeBody, { html })))
  })
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
  vi.useRealTimers()
  useUi.setState({ lightbox: null })
})

describe('README code blocks', () => {
  it('wraps a fenced block once, with its language and a copy button', () => {
    render('<pre><code class="language-bash">curl -fsSL x | bash</code></pre>')
    expect(container.querySelectorAll('.gh-code')).toHaveLength(1)
    expect(container.querySelector('.gh-code-lang')?.textContent).toBe('bash')
    const button = container.querySelector('button[data-copy-code]')
    expect(button).not.toBeNull()
    expect(button?.getAttribute('aria-label')?.trim()).not.toBe('')
  })

  it('labels an unlabelled block as plain text and still offers the copy button', () => {
    render('<pre><code>plain</code></pre>')
    expect(container.querySelector('.gh-code-lang')?.textContent).toBe(t('development.github.repos.readme_text'))
    expect(container.querySelector('button[data-copy-code]')).not.toBeNull()
    expect(highlightWithPrism).not.toHaveBeenCalled()
  })

  it('colours the block through the shared Prism loader', async () => {
    render('<pre><code class="language-bash">curl x</code></pre>')
    await act(async () => { await Promise.resolve() })
    expect(highlightWithPrism).toHaveBeenCalledWith('curl x', 'bash')
    expect(container.querySelector('code .token.keyword')?.textContent).toBe('curl x')
  })

  it('folds a long block and expands it on request', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')
    render(`<pre><code class="language-bash">${lines}</code></pre>`)
    const block = container.querySelector('.gh-code')!
    expect(block.classList.contains('is-collapsed')).toBe(true)
    const button = container.querySelector<HTMLButtonElement>('[data-expand-code]')!
    expect(button.getAttribute('aria-expanded')).toBe('false')
    act(() => { button.click() })
    expect(block.classList.contains('is-expanded')).toBe(true)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.textContent).toBe(t('common.collapse'))
    act(() => { button.click() })
    expect(block.classList.contains('is-collapsed')).toBe(true)
    expect(button.textContent).toBe(t('development.github.common.expand'))
  })

  it('leaves a short block unfolded', () => {
    render('<pre><code class="language-bash">one\ntwo</code></pre>')
    expect(container.querySelector('[data-expand-code]')).toBeNull()
  })

  it('opens the shared lightbox for a README image', () => {
    useUi.setState({ lightbox: null })
    render('<p><img src="https://example.com/a.png" alt="shot"></p>')
    act(() => { container.querySelector('img')!.click() })
    expect(useUi.getState().lightbox).toEqual({ src: 'https://example.com/a.png', alt: 'shot' })
  })

  it('leaves an image that is already a link alone', () => {
    useUi.setState({ lightbox: null })
    render('<p><a href="https://example.com"><img src="https://example.com/a.png" alt="shot"></a></p>')
    act(() => { container.querySelector('img')!.click() })
    expect(useUi.getState().lightbox).toBeNull()
  })

  it('says the copy was refused instead of staying silent', async () => {
    vi.mocked(copyText).mockResolvedValueOnce(false)
    render('<pre><code class="language-bash">curl x</code></pre>')
    const button = container.querySelector<HTMLButtonElement>('button[data-copy-code]')!
    await act(async () => { button.click() })
    expect(button.textContent).toBe(t('development.github.common.copy_failed'))
  })

  it('copies the code text and restores the label afterwards', async () => {
    vi.useFakeTimers()
    render('<pre><code class="language-bash">curl x</code></pre>')
    const button = container.querySelector<HTMLButtonElement>('button[data-copy-code]')!
    await act(async () => { button.click() })
    expect(copyText).toHaveBeenCalledWith('curl x')
    expect(button.textContent).toBe(t('common.copied'))
    await act(async () => { vi.advanceTimersByTime(1_500) })
    expect(button.textContent).toBe(t('common.copy'))
  })
})
