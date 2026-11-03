/**
 * The publish panel owns metadata that has no autosave, so the editor has to be told when a field
 * is edited: that flag is what the back link and the drawer close read before letting the page go.
 */
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlogPostAdminDetail } from '@shared/blog/model'
import { initI18n } from '../../lib/i18n'
import { PostPublishPanel } from './PostPublishPanel'

vi.mock('../../lib/api', () => ({
  api: {
    blog: {
      taxonomy: { list: async () => ({ categories: [], series: [], tags: [] }) },
      settings: { get: async () => ({ site: { url: '' } }) },
      patchPost: async () => undefined,
    },
  },
}))

vi.mock('../blog/publish', () => ({ updateNoteBlogMeta: async () => true }))

function post(): BlogPostAdminDetail {
  return {
    id: 'post-1', noteId: 'note-1', slug: 'hello', permalink: '', title: 'Hello', excerpt: '',
    description: '', coverUrl: null, category: null, series: null, seriesOrder: null, tags: [],
    pinned: false, language: '', publishedAt: null, updatedAt: 1, wordCount: 0, readingMinutes: 0,
    encrypted: false, hideHomeContent: false, status: 'draft', renderStatus: 'ready', renderHash: '',
    createdAt: 1, viewCount: 0, commentCount: 0, noteTitle: 'Hello', noteUpdatedAt: 1,
    contentHash: '', renderGeneratedAt: null, rendererVersion: '', coverAssetId: null, categoryId: null,
    seriesId: null, commentsEnabled: true, license: '', alias: '', passwordHint: '',
  }
}

let root: Root
let container: HTMLDivElement
let dirty = false

function Probe() {
  const dirtyRef = useRef(false)
  const publishRef = useRef<(() => Promise<void>) | null>(null)
  return createElement(PostPublishPanel, {
    noteId: 'note-1',
    post: post(),
    noteUpdatedAt: 1,
    savingNote: false,
    publishRef,
    onChanged: async () => {},
    onOpenHistory: () => {},
    dirtyRef,
    onDirtyChange: (next: boolean) => { dirty = next },
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  dirty = false
  await initI18n()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.unstubAllGlobals()
})

describe('publish panel dirty reporting', () => {
  it('reports a clean panel on mount', async () => {
    await act(async () => { root.render(createElement(Probe)); await Promise.resolve() })
    expect(dirty).toBe(false)
  })

  it('reports an edit to the slug the editor can guard on', async () => {
    await act(async () => { root.render(createElement(Probe)); await Promise.resolve() })
    const slug = [...container.querySelectorAll<HTMLInputElement>('input')]
      .find((input) => input.value === 'hello')
    expect(slug).toBeTruthy()
    await act(async () => {
      // React tracks the previous value on the DOM node; the native setter is what its onChange
      // listener sees as a real edit.
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setValue.call(slug, 'changed-slug')
      slug!.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    expect(dirty).toBe(true)
  })
})
