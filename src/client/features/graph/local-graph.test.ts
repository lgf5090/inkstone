import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphResponse } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { LocalGraphPanel } from './LocalGraphPanel'

const PREFS_KEY = 'inkstone.graph.preferences.v1'
const TITLES = Array.from({ length: 6 }, (_, index) => `Note ${index + 1}`)

type GraphParams = NonNullable<Parameters<typeof api.graph>[0]>

let root: Root
let container: HTMLDivElement
let frameQueue = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let pendingResolvers: Array<(value: GraphResponse) => void> = []
let graphCalls: GraphParams[] = []
let closeMock = vi.fn()
let fullGraphMock = vi.fn()

function graphResponse(): GraphResponse {
  return {
    nodes: TITLES.map((title, index) => ({
      id: `note-${index}`,
      title,
      kind: 'note' as const,
      degree: 1,
      inDegree: 1,
      outDegree: 1,
      folderId: null,
      folderName: null,
      folderColor: null,
      tags: [],
    })),
    edges: TITLES.slice(1).map((_, index) => ({ source: `note-${index}`, target: `note-${index + 1}` })),
    meta: {
      mode: 'local', centerId: 'note-0', depth: 1,
      totalNodes: TITLES.length, totalEdges: TITLES.length - 1, truncated: false, limit: 350,
    },
  }
}

async function pump(frames: number) {
  for (let index = 0; index < frames; index += 1) {
    const batch = [...frameQueue.values()]
    if (!batch.length) return
    frameQueue.clear()
    await act(async () => { batch.forEach((callback) => callback(index * 16)) })
  }
}

function buttons(scope: ParentNode) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')]
}

function buttonByLabel(label: string) {
  return buttons(document).find((node) => node.getAttribute('aria-label') === label)
}

async function click(node: HTMLElement) {
  await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

async function takeRequest() {
  const resolve = pendingResolvers.shift()
  if (!resolve) throw new Error('no pending graph request')
  await act(async () => { resolve(graphResponse()) })
}

async function mount() {
  await act(async () => {
    root.render(createElement(LocalGraphPanel, {
      noteId: 'note-0',
      onClose: closeMock,
      onOpenFullGraph: fullGraphMock,
    }))
  })
}

function lastRequest(): GraphParams {
  const last = graphCalls[graphCalls.length - 1]
  if (!last) throw new Error('no graph request recorded')
  return last
}

const originalNotes = useNotes.getState()
const originalUi = useUi.getState()

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: false, media: query,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })) as unknown as typeof matchMedia)
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  frameQueue = new Map()
  nextFrameId = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frameQueue.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frameQueue.delete(id) })
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const store: Record<string, unknown> = {}
    return new Proxy(store, {
      get: (target, prop) => {
        if (prop in target) return target[prop as string]
        return () => undefined
      },
      set: (target, prop, value) => { target[prop as string] = value; return true },
    })
  } as unknown as HTMLCanvasElement['getContext']
  pendingResolvers = []
  graphCalls = []
  localStorage.clear()
  await initI18n()
  closeMock = vi.fn()
  fullGraphMock = vi.fn()
  useNotes.setState({ openNote: vi.fn(), createNote: vi.fn(), hydrated: true })
  useUi.setState({ activeNoteId: 'note-0' })
  vi.spyOn(api, 'graph').mockImplementation((params) => {
    graphCalls.push(params ?? {})
    return new Promise<GraphResponse>((resolve) => { pendingResolvers.push(resolve) })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  const resolvers = pendingResolvers.splice(0)
  await act(async () => { resolvers.forEach((resolve) => resolve(graphResponse())) })
  await act(async () => { root.unmount() })
  container.remove()
  useNotes.setState(originalNotes, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('local graph companion', () => {
  it('asks for the neighbourhood of the note it is built on', async () => {
    await mount()
    expect(lastRequest().mode).toBe('local')
    expect(lastRequest().center).toBe('note-0')
    await takeRequest()
    await pump(2)
    expect(document.querySelector('canvas')).not.toBeNull()
    expect(document.querySelector('section')?.getAttribute('aria-label')).toBe(t('graph.local_graph'))
  })

  it('names the panel and counts the notes it drew', async () => {
    await mount()
    await takeRequest()
    expect(document.body.textContent).toContain(t('graph.local_graph'))
    expect(document.body.textContent).toContain(`· ${TITLES.length}`)
  })

  it('takes the depth the reader sets without writing the shared preference', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'global', depth: 1 }))
    await mount()
    await takeRequest()
    const select = document.querySelector<HTMLSelectElement>('select[aria-label="' + t('graph.depth') + '"]')
    expect(select).not.toBeNull()
    await act(async () => {
      select!.value = '3'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(lastRequest().depth).toBe(3)
    expect(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}').depth).toBe(1)
  })

  it('leads out to the full graph and closes itself', async () => {
    await mount()
    await takeRequest()
    await click(buttonByLabel(t('graph.open_full_graph'))!)
    expect(fullGraphMock).toHaveBeenCalled()
    await click(buttonByLabel(t('common.close'))!)
    expect(closeMock).toHaveBeenCalled()
  })

  it('offers the picture export the full panel offers', async () => {
    await mount()
    expect(buttonByLabel(t('graph.export_png'))?.disabled).toBe(true)
    await takeRequest()
    expect(buttonByLabel(t('graph.export_png'))?.disabled).toBe(false)
    expect(buttonByLabel(t('graph.fit'))?.disabled).toBe(false)
  })

  it('says so when the neighbourhood could not be loaded', async () => {
    vi.spyOn(api, 'graph').mockImplementation(() => Promise.reject(new Error('offline')))
    await mount()
    await act(async () => {})
    await act(async () => {})
    expect(document.body.textContent).toContain(t('graph.could_not_load_graph'))
    expect(document.body.textContent).toContain('offline')
  })
})
