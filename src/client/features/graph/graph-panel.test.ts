import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, GraphResponse } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { GraphPanel } from './GraphPanel'

const PREFS_KEY = 'inkstone.graph.preferences.v1'
const SPIRAL_ANGLE = 2.399963
const SPIRAL_RADIUS = 18
const FRAME_BUDGET = 180
const TITLES = Array.from({ length: 12 }, (_, index) => `Note ${index + 1}`)

type GraphParams = Parameters<typeof api.graph>[0]
type MessageKey = Parameters<typeof t>[0]
type Draw = { op: string; args: number[] }

let draws: Draw[] = []
let frameQueue = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let pendingResolvers: Array<(value: GraphResponse) => void> = []
let graphCalls: GraphParams[] = []
let reducedMotion = false
let root: Root
let container: HTMLDivElement

function graphResponse(titles: string[]): GraphResponse {
  return {
    nodes: titles.map((title, index) => ({
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
    edges: titles.slice(1).map((_, index) => ({ source: `note-${index}`, target: `note-${index + 1}` })),
    meta: {
      mode: 'global',
      centerId: null,
      depth: 1,
      totalNodes: titles.length,
      totalEdges: Math.max(0, titles.length - 1),
      truncated: false,
      limit: 350,
    },
  }
}

function installCanvas() {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, prop) => (...args: number[]) => {
        if (prop === 'arc' || prop === 'translate' || prop === 'scale') {
          draws.push({ op: String(prop), args })
        }
      },
      set: () => true,
    })
  } as unknown as HTMLCanvasElement['getContext']
}

function installRaf() {
  frameQueue = new Map()
  nextFrameId = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrameId++
    frameQueue.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frameQueue.delete(id)
  })
}

async function pump(frames: number) {
  for (let index = 0; index < frames; index += 1) {
    const batch = [...frameQueue.values()]
    if (!batch.length) return false
    frameQueue.clear()
    draws = []
    await act(async () => {
      batch.forEach((callback) => callback(index * 16))
    })
  }
  return true
}

async function pumpUntilIdle(limit = FRAME_BUDGET + 40) {
  for (let index = 0; index < limit; index += 1) {
    if (!await pump(1)) return index
  }
  return limit
}

function arcPositions(): Array<[number, number]> {
  return draws.filter((draw) => draw.op === 'arc').map((draw) => [draw.args[0]!, draw.args[1]!])
}

function arcRadii(): number[] {
  return draws.filter((draw) => draw.op === 'arc').map((draw) => draw.args[2]!)
}

function scaleOps(): number[] {
  return draws.filter((draw) => draw.op === 'scale').map((draw) => draw.args[0]!)
}

function spiralPositions(count: number): Array<[number, number]> {
  return Array.from({ length: count }, (_, index) => [
    Math.cos(index * SPIRAL_ANGLE) * SPIRAL_RADIUS * Math.sqrt(index),
    Math.sin(index * SPIRAL_ANGLE) * SPIRAL_RADIUS * Math.sqrt(index),
  ])
}

function maxDeviation(left: Array<[number, number]>, right: Array<[number, number]>) {
  if (left.length !== right.length) return Number.POSITIVE_INFINITY
  return Math.max(...left.map((point, index) => Math.hypot(point[0] - right[index]![0], point[1] - right[index]![1])))
}

function buttons(scope: ParentNode) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')]
}

function buttonByLabel(label: string) {
  return buttons(document).find((node) => node.getAttribute('aria-label') === label)
}

function buttonByText(text: string) {
  return buttons(document).find((node) => node.textContent?.trim() === text)
}

async function click(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function setNativeValue(node: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(node, value)
}

async function setRange(labelKey: MessageKey, value: string) {
  const field = [...document.querySelectorAll('label')]
    .find((node) => node.textContent?.includes(t(labelKey)))
  const input = field?.querySelector('input')
  if (!input) throw new Error(`range for ${labelKey} not found`)
  await act(async () => {
    setNativeValue(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  if (!field!.textContent?.includes(value)) throw new Error(`range ${labelKey} did not take value ${value}`)
}

async function typeSearch(value: string) {
  const input = document.querySelector<HTMLInputElement>('header input')
  if (!input) throw new Error('search input not found')
  const callsBefore = graphCalls.length
  await act(async () => {
    setNativeValue(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(240)
  })
  if (graphCalls.length === callsBefore) throw new Error(`search "${value}" did not trigger a graph request`)
}

async function openSettings() {
  const trigger = buttonByLabel(t('graph.settings'))
  if (!trigger) throw new Error('settings trigger not found')
  await click(trigger)
}

function takeRequest() {
  const resolve = pendingResolvers.shift()
  if (!resolve) throw new Error('no pending graph request')
  return act(async () => {
    resolve(graphResponse(TITLES))
  })
}

async function mount() {
  await act(async () => {
    root.render(createElement(GraphPanel, { onClose: vi.fn() }))
  })
}

const originalNotes = useNotes.getState()
const originalUi = useUi.getState()

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', ((query: string) => ({
    matches: query.includes('reduced-motion') && reducedMotion,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof matchMedia)
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  installCanvas()
  installRaf()
  reducedMotion = false
  draws = []
  graphCalls = []
  pendingResolvers = []
  localStorage.clear()
  await initI18n()
  const folders: Folder[] = [{
    id: 'folder-1',
    parentId: null,
    name: 'Alpha',
    icon: null,
    color: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  }]
  useNotes.setState({ folders, tags: [], hydrated: true, loading: false })
  useUi.setState({ activeNoteId: null })
  vi.spyOn(api, 'graph').mockImplementation((params) => {
    graphCalls.push(params)
    return new Promise<GraphResponse>((resolve) => {
      pendingResolvers.push(resolve)
    })
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  const resolvers = pendingResolvers.splice(0)
  await act(async () => {
    resolvers.forEach((resolve) => resolve(graphResponse([])))
  })
  await act(async () => {
    root.unmount()
  })
  container.remove()
  useNotes.setState(originalNotes, true)
  useUi.setState(originalUi, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('graph scene lifecycle', () => {
  it('keeps the canvas mounted while a later request is in flight', async () => {
    await mount()
    await takeRequest()
    const mounted = document.querySelector('canvas')
    expect(mounted).not.toBeNull()

    await typeSearch('Beta')
    expect(document.querySelector('canvas')).toBe(mounted)

    await takeRequest()
    expect(document.querySelector('canvas')).toBe(mounted)
  })

  it('inherits settled node positions instead of restarting the spiral on every request', async () => {
    await mount()
    await takeRequest()
    await pumpUntilIdle()
    const settled = arcPositions()
    expect(settled.length).toBe(TITLES.length)

    await typeSearch('note')
    await takeRequest()
    await pump(1)
    expect(maxDeviation(arcPositions(), settled)).toBeLessThan(6)
  })

  it('does not rebuild the scene when only the node size changes', async () => {
    await mount()
    await takeRequest()
    await openSettings()
    await pumpUntilIdle()
    const before = arcRadii()
    const settledPositions = arcPositions()
    expect(before[0]).toBeGreaterThan(0)

    await setRange('graph.node_size', '1.6')
    const frames = await pumpUntilIdle()
    expect(frames).toBeGreaterThan(0)
    expect(frames).toBeLessThanOrEqual(2)
    expect(arcRadii()[0]!).toBeGreaterThan(before[0]!)
    expect(maxDeviation(arcPositions(), settledPositions)).toBeLessThan(1)
  })

  it('lays the graph out even when reduced motion is requested', async () => {
    reducedMotion = true
    await mount()
    await takeRequest()
    await pump(1)
    const drawn = arcPositions()
    expect(drawn.length).toBe(TITLES.length)
    expect(maxDeviation(drawn, spiralPositions(TITLES.length))).toBeGreaterThan(6)
  })

  it('does not restart a cold frame budget on every force-parameter step', async () => {
    await mount()
    await takeRequest()
    await openSettings()
    await pumpUntilIdle()

    await setRange('graph.repulsion', '950')
    const frames = await pumpUntilIdle()
    expect(frames).toBeGreaterThan(0)
    expect(frames).toBeLessThan(FRAME_BUDGET)
  })

  it('fits the view when the simulation settles without waiting for a timer', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    expect(scaleOps()[0]).toBe(1)
    await pumpUntilIdle()
    expect(scaleOps().at(-1)).not.toBe(1)
  })
})

describe('graph preference durability', () => {
  it('flushes a pending preference write when the panel unmounts', async () => {
    await mount()
    await takeRequest()
    await openSettings()
    await setRange('graph.repulsion', '1500')

    await act(async () => {
      root.unmount()
    })
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    expect(stored.repulsion).toBe(1500)
    root = createRoot(container)
  })
})

describe('graph empty states', () => {
  it('drops a folder filter that no longer exists', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'global', folderId: 'k'.repeat(26) }))
    await mount()
    expect(graphCalls[0]?.folderId).toBeUndefined()
  })

  it('says the graph was filtered when an active filter empties it', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'global', folderId: 'k'.repeat(26) }))
    await mount()
    await act(async () => {
      pendingResolvers.shift()!(graphResponse(TITLES))
    })
    await typeSearch('zzzz-no-match')
    await act(async () => {
      pendingResolvers.shift()!(graphResponse([]))
    })
    expect(document.body.textContent).toContain(t('graph.filtered_empty'))
    const clear = buttonByText(t('graph.clear_filters'))
    expect(clear).toBeDefined()

    await click(clear!)
    expect(document.querySelector<HTMLInputElement>('header input')?.value).toBe('')
  })

  it('offers to leave local mode instead of a retry that can never succeed', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'local' }))
    await mount()
    expect(graphCalls.length).toBe(0)
    const action = buttonByText(t('graph.use_global'))
    expect(action).toBeDefined()

    await click(action!)
    expect(graphCalls[0]?.mode).toBe('global')
  })
})
