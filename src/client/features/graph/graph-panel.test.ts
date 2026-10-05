import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Folder, GraphResponse } from '@shared/types'
import { initI18n, t } from '../../lib/i18n'
import { api } from '../../lib/api'
import { useNotes } from '../../store/notes'
import { useUi } from '../../store/ui'
import { GraphPanel, pickDirectional, type CanvasNode } from './GraphPanel'

const PREFS_KEY = 'inkstone.graph.preferences.v1'
const SPIRAL_ANGLE = 2.399963
const SPIRAL_RADIUS = 18
const FRAME_BUDGET = 180
const TITLES = Array.from({ length: 12 }, (_, index) => `Note ${index + 1}`)

type GraphParams = Parameters<typeof api.graph>[0]
type MessageKey = Parameters<typeof t>[0]
type Draw = { op: string; args: number[]; alpha: number }

let draws: Draw[] = []
let strokes: string[] = []
let texts: string[] = []
let frameQueue = new Map<number, FrameRequestCallback>()
let nextFrameId = 1
let pendingResolvers: Array<(value: GraphResponse) => void> = []
let graphCalls: GraphParams[] = []
let reducedMotion = false
let themeName = 'light'
let root: Root
let container: HTMLDivElement
let closeMock = vi.fn()
let openNoteMock = vi.fn()
let createNoteMock = vi.fn()

function graphResponse(titles: string[], folderName: string | null = null): GraphResponse {
  return {
    nodes: titles.map((title, index) => ({
      id: `note-${index}`,
      title,
      kind: 'note' as const,
      degree: 1,
      inDegree: 1,
      outDegree: 1,
      folderId: folderName ? 'k'.repeat(26) : null,
      folderName,
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

function installComputedStyle() {
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (name: string) => {
      if (name === '--graph-edge') return themeName === 'dark' ? '#101010' : '#efefef'
      if (name === '--graph-edge-dim') return themeName === 'dark' ? '#222222' : '#dddddd'
      if (name === '--graph-node') return '#333333'
      if (name === '--graph-label') return '#444444'
      if (name === '--accent') return '#555555'
      if (name === '--font-ui') return 'Inter'
      return ''
    },
  }))
}

function installCanvas() {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    const store: Record<string, unknown> = {}
    return new Proxy(store, {
      get: (target, prop) => {
        if (prop in target) return target[prop as string]
        return (...args: number[]) => {
          if (prop === 'arc' || prop === 'translate' || prop === 'scale') {
            draws.push({ op: String(prop), args, alpha: Number(store.globalAlpha ?? 1) })
          }
          if (prop === 'stroke') strokes.push(String(store.strokeStyle))
          if (prop === 'fillText') texts.push(String(store.fillStyle))
        }
      },
      set: (target, prop, value) => {
        target[prop as string] = value
        return true
      },
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
    strokes = []
    texts = []
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

function arcAlphas(): number[] {
  return draws.filter((draw) => draw.op === 'arc').map((draw) => draw.alpha)
}

function nodeArcs(): Array<[number, number]> {
  const arcs = draws.filter((draw) => draw.op === 'arc')
  const smallest = Math.min(...arcs.map((arc) => arc.args[2]!))
  return arcs.filter((arc) => arc.args[2] === smallest).map((arc) => [arc.args[0]!, arc.args[1]!])
}

function scaleOps(): number[] {
  return draws.filter((draw) => draw.op === 'scale').map((draw) => draw.args[0]!)
}

function translateOps(): number[] {
  const first = draws.find((draw) => draw.op === 'translate')
  return first ? [first.args[0]!, first.args[1]!] : []
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

async function setRange(labelKey: MessageKey, value: string, prefKey: string) {
  const label = t(labelKey)
  const input = document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`)
  if (!input) throw new Error(`range for ${labelKey} not found`)
  await act(async () => {
    setNativeValue(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
  })
  await act(async () => {
    vi.advanceTimersByTime(340)
  })
  const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  if (stored[prefKey] !== Number(value)) {
    throw new Error(`range ${labelKey} did not reach preferences (${prefKey}=${stored[prefKey]}, wanted ${value})`)
  }
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
  closeMock = vi.fn()
  await act(async () => {
    root.render(createElement(GraphPanel, { onClose: closeMock }))
  })
}

function firePointer(node: Element, type: string, init: Record<string, unknown>) {
  const base = { bubbles: true, clientX: 0, clientY: 0, button: 0, pointerId: 1, isPrimary: true }
  const merged = { ...base, ...init }
  const Constructor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
  const event = new Constructor(type, merged)
  if (!('pointerId' in event)) Object.assign(event, { pointerId: merged.pointerId })
  act(() => {
    node.dispatchEvent(event)
  })
}

function canvasNode() {
  const canvas = document.querySelector('canvas')
  if (!canvas) throw new Error('canvas not mounted')
  return canvas
}

function selectedTitle(): string | null {
  const span = [...document.querySelectorAll('main span')]
    .find((node) => /^Note \d+$/.test(node.textContent ?? ''))
  return span?.textContent ?? null
}

function titleIndex(title: string | null): number {
  return Number((title ?? '').replace('Note ', '')) - 1
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
  installComputedStyle()
  installRaf()
  Element.prototype.setPointerCapture = function setPointerCapture() {}
  Element.prototype.releasePointerCapture = function releasePointerCapture() {}
  reducedMotion = false
  themeName = 'light'
  draws = []
  strokes = []
  texts = []
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
  closeMock = vi.fn()
  openNoteMock = vi.fn()
  createNoteMock = vi.fn()
  useNotes.setState({
    folders, tags: [{ id: 'tag-1', name: 'alpha', color: null, count: 2, createdAt: 1 }],
    hydrated: true, loading: false,
    openNote: openNoteMock, createNote: createNoteMock,
  })
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
    const settled = nodeArcs()
    expect(settled.length).toBe(TITLES.length)

    await typeSearch('note')
    await takeRequest()
    await pump(1)
    expect(maxDeviation(nodeArcs(), settled)).toBeLessThan(6)
  })

  it('does not rebuild the scene when only the node size changes', async () => {
    await mount()
    await takeRequest()
    await openSettings()
    await pumpUntilIdle()
    const before = arcRadii()
    const settledPositions = arcPositions()
    expect(before[0]).toBeGreaterThan(0)

    await setRange('graph.node_size', '1.6', 'nodeScale')
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

    await setRange('graph.repulsion', '950', 'repulsion')
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
    await setRange('graph.repulsion', '1500', 'repulsion')

    await act(async () => {
      root.unmount()
    })
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    expect(stored.repulsion).toBe(1500)
    root = createRoot(container)
  })
})

describe('graph canvas palette', () => {
  it('draws edges from an opaque graph token rather than a translucent border token', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    expect(strokes[0]).toBe('#efefef')
    expect(strokes[0]).not.toMatch(/17%|0\.17/)
  })

  it('repaints with the new palette when the theme changes', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    expect(strokes[0]).toBe('#efefef')

    themeName = 'dark'
    await act(async () => {
      document.documentElement.dataset.theme = 'dark'
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await pump(1)
    expect(strokes[0]).toBe('#101010')
    delete document.documentElement.dataset.theme
  })

  it('labels notes with the label token, not the secondary text token at reduced alpha', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    expect(texts[0]).toBe('#444444')
  })
})

describe('graph header and legend', () => {
  it('renders the counts from one message instead of concatenated fragments', async () => {
    await mount()
    await takeRequest()
    const heading = document.querySelector('header h2')?.parentElement?.textContent ?? ''
    expect(heading).toContain(t('graph.stats', { notes: TITLES.length, links: TITLES.length - 1 }))
  })

  it('shows a legend when colour is the only grouping cue', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'global', groupBy: 'folder' }))
    await mount()
    await act(async () => {
      pendingResolvers.shift()!(graphResponse(TITLES, 'Alpha'))
    })
    const legend = document.querySelector('[role="list"][aria-label]')
    expect(legend).not.toBeNull()
    expect(legend?.textContent).toContain('Alpha')
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

function synthetic(id: string, x: number, y: number): CanvasNode {
  return {
    id,
    title: id,
    kind: 'note',
    degree: 1,
    inDegree: 1,
    outDegree: 1,
    folderId: null,
    folderName: null,
    folderColor: null,
    tags: [],
    x,
    y,
    vx: 0,
    vy: 0,
    r: 6,
    colorGroup: null,
  }
}

describe('graph pointer and keyboard interaction', () => {
  it('walks the canvas by screen direction rather than array order', () => {
    const origin = synthetic('origin', 0, 0)
    const nearRight = synthetic('near-right', 40, 6)
    const farRight = synthetic('far-right', 300, -4)
    const aboveRight = synthetic('above-right', 60, -200)
    const nodes = [farRight, aboveRight, origin, nearRight]
    expect(pickDirectional(nodes, origin, 'ArrowRight')?.id).toBe('near-right')
    expect(pickDirectional(nodes, origin, 'ArrowUp')?.id).toBe('above-right')
    expect(pickDirectional(nodes, origin, 'ArrowLeft')).toBeNull()
  })

  it('opens a note on double-click rather than on a single click', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const [x, y] = arcPositions()[0]!
    const canvas = canvasNode()

    firePointer(canvas, 'pointerdown', { clientX: x, clientY: y })
    firePointer(canvas, 'pointerup', { clientX: x, clientY: y })
    await act(async () => {})
    expect(closeMock).not.toHaveBeenCalled()
    expect(openNoteMock).not.toHaveBeenCalled()

    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: x, clientY: y }))
    await act(async () => {})
    expect(openNoteMock).toHaveBeenCalledWith('note-0')
    expect(closeMock).toHaveBeenCalled()
  })

  it('keeps a dragged node where it was dropped', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const [x, y] = arcPositions()[1]!
    const canvas = canvasNode()

    firePointer(canvas, 'pointerdown', { clientX: x, clientY: y })
    firePointer(canvas, 'pointermove', { clientX: x + 120, clientY: y + 90 })
    firePointer(canvas, 'pointerup', { clientX: x + 120, clientY: y + 90 })
    await pump(30)
    const dropped = arcPositions()[1]!
    expect(Math.abs(dropped[0] - (x + 120))).toBeLessThan(2)
    expect(Math.abs(dropped[1] - (y + 90))).toBeLessThan(2)
  })

  it('keeps direct neighbours at full strength when a node is hovered', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const [x, y] = arcPositions()[0]!
    firePointer(canvasNode(), 'pointermove', { clientX: x, clientY: y })
    await pump(1)
    const alphas = arcAlphas()
    expect(alphas[0]).toBe(1)
    expect(alphas[1]).toBe(1)
    expect(alphas[TITLES.length - 1]).toBeLessThan(1)
  })

  it('still starts a drag after a lost pointer capture', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const [x, y] = arcPositions()[2]!
    const canvas = canvasNode()

    firePointer(canvas, 'pointerdown', { clientX: x, clientY: y, pointerId: 1 })
    firePointer(canvas, 'lostpointercapture', { pointerId: 1 })
    firePointer(canvas, 'pointerdown', { clientX: x, clientY: y, pointerId: 2 })
    firePointer(canvas, 'pointermove', { clientX: x + 80, clientY: y + 40, pointerId: 2 })
    await pump(1)
    expect(Math.abs(arcPositions()[2]![0] - (x + 80))).toBeLessThan(2)
  })

  it('ignores a right-button release while the left button is dragging', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const [x, y] = arcPositions()[0]!
    const canvas = canvasNode()

    firePointer(canvas, 'pointerdown', { clientX: x, clientY: y, pointerId: 1, button: 0 })
    firePointer(canvas, 'pointermove', { clientX: x + 40, clientY: y, pointerId: 1 })
    firePointer(canvas, 'pointerup', { clientX: x + 40, clientY: y, pointerId: 1, button: 2 })
    firePointer(canvas, 'pointermove', { clientX: x + 120, clientY: y, pointerId: 1 })
    await pump(1)
    expect(Math.abs(arcPositions()[0]![0] - (x + 120))).toBeLessThan(2)
  })

  it('keeps the hit target at least seven css pixels wide when zoomed out', async () => {
    await mount()
    await takeRequest()
    const canvas = canvasNode()
    for (let step = 0; step < 4; step += 1) {
      await act(async () => {
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }))
      })
    }
    await pump(1)
    const scale = scaleOps()[0]!
    expect(scale).toBeLessThan(0.5)
    const placed = arcPositions()
    let rightmost = 0
    for (let index = 1; index < placed.length; index += 1) {
      if (placed[index]![0] > placed[rightmost]![0]) rightmost = index
    }
    const [x, y] = placed[rightmost]!

    firePointer(canvas, 'pointermove', { clientX: (x + 30) * scale, clientY: y * scale })
    await pump(1)
    expect(selectedTitle()).not.toBeNull()
  })

  it('anchors keyboard zoom at the viewport centre rather than the world origin', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const canvas = canvasNode()
    canvas.getBoundingClientRect = () => ({
      left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50,
    } as DOMRect)

    firePointer(canvas, 'pointerdown', { clientX: 700, clientY: 500 })
    firePointer(canvas, 'pointermove', { clientX: 750, clientY: 520 })
    firePointer(canvas, 'pointerup', { clientX: 750, clientY: 520 })
    await pump(1)
    expect(translateOps()).toEqual([50, 20])

    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))
    })
    await pump(1)
    const after = translateOps()
    expect(Math.abs(after[0] + 20)).toBeLessThan(1)
    expect(Math.abs(after[1] + 36)).toBeLessThan(1)
  })

  it('surfaces active filters as chips in the header', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: 'global', tag: 'alpha' }))
    await mount()
    await takeRequest()
    expect(document.body.textContent).toContain(t('graph.tag'))
    const chip = buttonByText(`${t('graph.tag')} alpha`)
    expect(chip).toBeDefined()

    await click(chip!)
    const calls = graphCalls.length
    await takeRequest()
    expect(graphCalls[calls]?.tag).toBeUndefined()
  })

  it('closes the settings drawer before the panel on Escape', async () => {
    await mount()
    await takeRequest()
    await openSettings()
    expect(document.querySelector('aside[role="dialog"]')).not.toBeNull()
    expect(buttonByLabel(t('graph.settings'))?.getAttribute('aria-pressed')).toBe('true')
    expect(buttonByLabel(t('graph.settings'))?.className).toContain('accent-soft')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('aside[role="dialog"]')).toBeNull()
    expect(closeMock).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(closeMock).toHaveBeenCalled()
  })

  it('moves the selection to the spatial neighbour on ArrowRight', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const canvas = canvasNode()
    const press = async (key: string) => {
      await act(async () => {
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
    }

    await press('ArrowRight')
    const first = selectedTitle()
    expect(first).toMatch(/^Note \d+$/)
    await pump(1)

    await press('ArrowRight')
    const second = selectedTitle()
    expect(second).toMatch(/^Note \d+$/)
    expect(second).not.toBe(first)
    const placed = nodeArcs()
    expect(placed.length).toBe(TITLES.length)
    expect(placed[titleIndex(second)][0]).toBeGreaterThan(placed[titleIndex(first)][0])
  })

  it('opens the node menu from the keyboard and pins the node from it', async () => {
    await mount()
    await takeRequest()
    await pump(1)
    const canvas = canvasNode()
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
    })

    const menu = document.querySelector('[role="menu"]')
    expect(menu).not.toBeNull()
    const pin = [...menu!.querySelectorAll('button')].find((node) => node.textContent?.includes(t('graph.pin')))
    expect(pin).toBeDefined()

    await click(pin!)
    await pump(1)
    expect(strokes).toContain('#444444')

    await act(async () => {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }))
    })
    const again = document.querySelector('[role="menu"]')
    expect([...again!.querySelectorAll('button')].some((node) => node.textContent?.includes(t('graph.unpin')))).toBe(true)
    expect([...again!.querySelectorAll('button')].some((node) => node.textContent?.trim() === t('graph.pin'))).toBe(false)
  })
})
