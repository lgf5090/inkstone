/**
 * The README image rule, mounted the way the drawer mounts it.
 *
 * `MarkdownBody` rewrites image sources after React has drawn the sanitised fragment, and the rewrite
 * reads back the attribute it just wrote. Under StrictMode the effect runs twice over the same DOM, so
 * a second pass that treats its own output as an input wraps every URL around the proxy twice and each
 * image answers 404 — which is exactly what a browser shows and a source-scanning test cannot see.
 */
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownBody } from '../src/client/features/cloudflare/components/MarkdownBody'
import { initI18n } from '../src/client/lib/i18n'
import { installTestGlobals } from '../src/client/lib/test-render'

const README_URL = 'https://raw.githubusercontent.com/lyc8503/UptimeFlare/main/README.md'

let root: Root
let container: HTMLDivElement

/** The proxied sources as the browser would request them, with the `url=` parameter decoded. */
function proxiedSources(): string[] {
  return [...container.querySelectorAll('img')].map((image) => {
    const src = image.getAttribute('src') ?? ''
    if (!src.startsWith('/api/cloudflare/store/image')) return src
    return new URL(src, 'http://localhost').searchParams.get('url') ?? ''
  })
}

/** A decoded source that still names the proxy is the signature of a second wrapping pass. */
function rewrapped(sources: string[]): string[] {
  return sources.filter((source) => source.includes('api/cloudflare/store/image'))
}

function render(source: string, baseHref?: string): void {
  act(() => {
    root.render(createElement(StrictMode, null, createElement(MarkdownBody, { source, baseHref })))
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
})

describe('README image sources', () => {
  it('draws under StrictMode, so the double effect run is part of every case', () => {
    render('![shot](https://example.com/a.png)', README_URL)
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  it('proxies each image exactly once, never around its own output', () => {
    render([
      '![badge](https://img.shields.io/badge/-English-A31F34?style=for-the-badge)',
      '',
      '![shot](https://raw.githubusercontent.com/lyc8503/UptimeFlare/main/docs/desktop.png)',
    ].join('\n'), README_URL)
    const sources = proxiedSources()
    expect(sources).toEqual([
      'https://img.shields.io/badge/-English-A31F34?style=for-the-badge',
      'https://raw.githubusercontent.com/lyc8503/UptimeFlare/main/docs/desktop.png',
    ])
    expect(rewrapped(sources), 'the proxy wrapped its own output').toEqual([])
  })

  it('resolves a relative path against the README, not against the notebook', () => {
    render('![demo](doc/Demo.png)\n\n![root](/assets/root.png)', 'https://example.com/owner/repo/main/README.md')
    expect(proxiedSources()).toEqual([
      'https://example.com/owner/repo/main/doc/Demo.png',
      'https://example.com/assets/root.png',
    ])
  })

  it('leaves a relative path alone when the README has no address of its own', () => {
    render('![demo](doc/Demo.png)')
    expect(proxiedSources()).toEqual(['doc/Demo.png'])
  })

  it('keeps inline data images out of the proxy', () => {
    render('![dot](data:image/png;base64,iVBORw0KGgo=)')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})
