import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals } from '../../../test-render'
import { KANBAN_FILE_READ_TIMEOUT_MS, KANBAN_FILE_TEXT_MAX_BYTES, KanbanFilePreviewModal } from './kanban-file-preview-modal'
import type { KanbanFile } from '../types'

beforeAll(async () => {
  await initI18n()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const pdfFile: KanbanFile = {
  id: 'file-1',
  name: 'spec.pdf',
  size: 2048,
  mime: 'application/pdf',
  url: '/api/kanban/file/default/1-spec.pdf',
}

const remoteImage: KanbanFile = {
  id: 'file-2',
  name: 'shot.png',
  size: 4096,
  mime: 'image/png',
  url: 'https://tracker.example.test/pixel.png',
}

const localImage: KanbanFile = { ...remoteImage, id: 'file-3', url: '/api/kanban/file/default/3-shot.png' }

const textFile: KanbanFile = {
  id: 'file-4',
  name: 'notes.txt',
  size: 512,
  mime: 'text/plain',
  url: '/api/kanban/file/default/4-notes.txt',
}

const remoteTextFile: KanbanFile = { ...textFile, id: 'file-5', url: 'https://tracker.example.test/notes.txt' }

/** The shape the read actually touches: ok, the body, and — where a stub provides them — size metadata. */
interface FakeReadResponse {
  ok: boolean
  status?: number
  text: () => Promise<string>
  headers?: { get: (name: string) => string | null }
  body?: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> } }
}

function stubTextRead(respond: (url: string, init?: RequestInit) => Promise<FakeReadResponse>) {
  const fetchMock = vi.fn(respond)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** The read is a promise chain, so the assertions run after the microtask queue has drained. */
async function flushRead(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

function renderPreview(file: KanbanFile | null) {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(KanbanFilePreviewModal, { file, onClose: vi.fn() }))
  })
  return {
    dispose: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

describe('KanbanFilePreviewModal for an image', () => {
  it('shows an image from another origin without a referrer', () => {
    const rendered = renderPreview(remoteImage)
    try {
      const image = document.querySelector('img')
      expect(image, 'a remote preview was not rendered').not.toBeNull()
      expect(image!.getAttribute('referrerpolicy')).toBe('no-referrer')
    } finally {
      rendered.dispose()
    }
  })

  it('shows a same-origin image', () => {
    const rendered = renderPreview(localImage)
    try {
      expect(document.querySelector('img')).not.toBeNull()
    } finally {
      rendered.dispose()
    }
  })

  it('never blocks a document it cannot draw as an image anyway', () => {
    const rendered = renderPreview(pdfFile)
    try {
      expect(document.body.textContent).toContain('spec.pdf')
    } finally {
      rendered.dispose()
    }
  })
})

describe('KanbanFilePreviewModal when an image cannot be drawn', () => {
  it('says so when an allowed image fails to load, rather than leaving a broken frame', () => {
    const rendered = renderPreview(remoteImage)
    try {
      const image = document.querySelector('img')
      expect(image).not.toBeNull()
      act(() => {
        image!.dispatchEvent(new Event('error'))
      })
      expect(document.querySelector('img'), 'the broken image stayed on screen').toBeNull()
      expect(document.body.textContent).toContain(t('preview.kanban_file_load_failed'))
    } finally {
      rendered.dispose()
    }
  })
})

describe('KanbanFilePreviewModal for text', () => {
  it('shows the text when the read succeeds', async () => {
    stubTextRead(async () => ({ ok: true, text: async () => 'hello board' }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(document.querySelector('pre')?.textContent).toBe('hello board')
    } finally {
      rendered.dispose()
    }
  })

  it('treats a stored file that is gone as a failed read, not as its body', async () => {
    stubTextRead(async () => ({ ok: false, status: 404, text: async () => 'File not found' }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(document.body.textContent).toContain(t('preview.kanban_file_load_failed'))
      expect(document.body.textContent, 'the 404 body was shown as the file\'s content').not.toContain('File not found')
    } finally {
      rendered.dispose()
    }
  })
})

describe('KanbanFilePreviewModal when a text read is past the size ceiling', () => {
  it('refuses a read that declares itself too large before its body is touched', async () => {
    const text = vi.fn(async () => 'never read')
    stubTextRead(async () => ({
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(KANBAN_FILE_TEXT_MAX_BYTES + 1) : null) },
      text,
    }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(document.querySelector('[data-kanban-file-too-large]'), 'an oversized file still drew a preview').not.toBeNull()
      expect(document.body.textContent).toContain(
        t('preview.kanban_file_too_large', { value1: String(KANBAN_FILE_TEXT_MAX_BYTES / (1024 * 1024)) }),
      )
      expect(text, 'the body was read although its size was already known').not.toHaveBeenCalled()
    } finally {
      rendered.dispose()
    }
  })

  it('stops reading a body that grows past the ceiling without declaring its size', async () => {
    // A body that never ends: each read hands back another chunk past the ceiling, and the read
    // must quit at the chunk that crosses it rather than buffer the rest.
    const encoder = new TextEncoder()
    const chunk = () => Promise.resolve({ done: false as const, value: encoder.encode('a'.repeat(1_500_000)) })
    stubTextRead(async () => ({
      ok: true,
      body: { getReader: () => ({ read: chunk, cancel: async () => {} }) },
      text: async () => 'never reached',
    }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(document.querySelector('[data-kanban-file-too-large]'), 'an unbounded body was read to the end').not.toBeNull()
      expect(document.body.textContent).toContain(
        t('preview.kanban_file_too_large', { value1: String(KANBAN_FILE_TEXT_MAX_BYTES / (1024 * 1024)) }),
      )
    } finally {
      rendered.dispose()
    }
  })
})

describe('KanbanFilePreviewModal when a text read does not produce the document', () => {
  it('says the read failed instead of showing an empty document', async () => {
    stubTextRead(async () => { throw new Error('offline') })
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(document.body.textContent).toContain(t('preview.kanban_file_load_failed'))
      expect(document.querySelector('pre'), 'a failed read still drew a document body').toBeNull()
    } finally {
      rendered.dispose()
    }
  })

  it('reads again when the reader asks it to', async () => {
    let attempt = 0
    const fetchMock = stubTextRead(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('offline')
      return { ok: true, text: async () => 'second try' }
    })
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      const retry = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === t('preview.kanban_file_retry'),
      )
      expect(retry, 'a failed read offered no way to read it again').toBeDefined()
      await act(async () => { retry!.click(); await Promise.resolve() })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(document.querySelector('pre')?.textContent).toBe('second try')
    } finally {
      rendered.dispose()
    }
  })

  it('calls a file with nothing in it empty, not broken', async () => {
    stubTextRead(async () => ({ ok: true, text: async () => '' }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(document.body.textContent).toContain(t('preview.kanban_file_empty'))
      expect(document.body.textContent).not.toContain(t('preview.kanban_file_load_failed'))
    } finally {
      rendered.dispose()
    }
  })
})

// Reading a text attachment is a request to whoever wrote the fence, so these cases pin that the read
// goes to the URL the fence named and its body is what reaches the page — and that a stored attachment
// reads the same way, since that is the common case.
describe('KanbanFilePreviewModal reading a text attachment from another origin', () => {
  it('reads it and shows the body it returned', async () => {
    const fetchMock = stubTextRead(async () => ({ ok: true, text: async () => 'remote body' }))
    const rendered = renderPreview(remoteTextFile)
    try {
      await flushRead()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]![0]).toBe(remoteTextFile.url)
      expect(document.querySelector('pre')?.textContent).toBe('remote body')
    } finally {
      rendered.dispose()
    }
  })

  it('reads a stored attachment the same way', async () => {
    const fetchMock = stubTextRead(async () => ({ ok: true, text: async () => 'local body' }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(document.querySelector('pre')?.textContent).toBe('local body')
    } finally {
      rendered.dispose()
    }
  })

})

describe('KanbanFilePreviewModal giving a text read a deadline', () => {
  it('gives up on a host that never answers, and offers the reader the way back', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const rendered = renderPreview(textFile)
    try {
      expect(document.querySelector('pre'), 'the read answered before it was even given time').toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(KANBAN_FILE_READ_TIMEOUT_MS) })
      expect(fetchMock, 'the deadline passed without a read going out').toHaveBeenCalledTimes(1)
      expect(document.body.textContent).toContain(t('preview.kanban_file_load_failed'))
      const retry = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === t('preview.kanban_file_retry'),
      )
      expect(retry, 'a read that ran out of time offered no retry').toBeDefined()
    } finally {
      rendered.dispose()
      vi.useRealTimers()
    }
  })
})

describe('KanbanFilePreviewModal when a read is no longer wanted', () => {
  it('aborts the read it opened when the panel closes', () => {
    const signals: (AbortSignal | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal)
      return new Promise(() => {})
    }))
    const rendered = renderPreview(textFile)
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(false)
    rendered.dispose()
    expect(signals[0]!.aborted, 'the read outlived the panel that asked for it').toBe(true)
  })

  it('aborts it when the reader retries, so only the newest read can write the panel', async () => {
    const signals: (AbortSignal | undefined)[] = []
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      signals.push(init?.signal)
      return Promise.reject(new Error('offline'))
    }))
    const rendered = renderPreview(textFile)
    try {
      await flushRead()
      const retry = [...document.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === t('preview.kanban_file_retry'),
      )
      await act(async () => { retry!.click(); await Promise.resolve() })
      expect(signals).toHaveLength(2)
      expect(signals[0]!.aborted, 'the superseded read was left running').toBe(true)
      expect(signals[1]!.aborted).toBe(false)
    } finally {
      rendered.dispose()
    }
  })
})

describe('KanbanFilePreviewModal file actions', () => {
  it('downloads a stored attachment in place, where the attribute means something', () => {
    const rendered = renderPreview(pdfFile)
    try {
      const download = document.querySelector<HTMLAnchorElement>('a[download]')
      expect(download, 'a same-origin attachment lost its download link').not.toBeNull()
      expect(download!.getAttribute('download')).toBe(pdfFile.name)
      expect(download!.getAttribute('target')).toBeNull()
    } finally {
      rendered.dispose()
    }
  })

  it('does not offer a download of another origin that would take the app\u2019s tab with it', () => {
    const rendered = renderPreview(remoteImage)
    try {
      expect(
        document.querySelector('a[download]'),
        'a cross-origin download link cannot download: the browser ignores the attribute and navigates instead',
      ).toBeNull()
      const externalLinks = [...document.querySelectorAll('a')].filter((a) => a.getAttribute('href') === remoteImage.url)
      expect(externalLinks.length).toBeGreaterThan(0)
      expect(externalLinks.every((a) => a.target === '_blank' && a.rel.includes('noopener'))).toBe(true)
    } finally {
      rendered.dispose()
    }
  })
})

describe('KanbanFilePreviewModal for PDF', () => {
  it('never embeds the document via <object>/<embed> (CSP object-src/frame-src none)', () => {
    const rendered = renderPreview(pdfFile)
    try {
      expect(document.querySelector('object')).toBeNull()
      expect(document.querySelector('embed')).toBeNull()
      expect(document.body.textContent).toContain('spec.pdf')
    } finally {
      rendered.dispose()
    }
  })

  it('offers a new-tab link pointing at the file url', () => {
    const rendered = renderPreview(pdfFile)
    try {
      const links = Array.from(document.querySelectorAll('a')).filter(
        (a) => a.getAttribute('href') === pdfFile.url,
      )
      expect(links.length).toBeGreaterThan(0)
      expect(links.some((a) => a.target === '_blank')).toBe(true)
    } finally {
      rendered.dispose()
    }
  })
})
