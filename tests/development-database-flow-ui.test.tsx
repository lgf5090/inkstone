// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedColumn, ParsedTable } from '../src/shared/development/database/types'
import { initI18n, t } from '../src/client/lib/i18n'
import { installTestGlobals, renderElement, type RenderedElement } from '../src/client/lib/test-render'
import { ErdView } from '../src/client/features/development/database/ErdView'
import { SvgFlow } from '../src/client/features/development/database/SvgFlow'

function column(name: string, type = 'TEXT', extra: Partial<ParsedColumn> = {}): ParsedColumn {
  return {
    name,
    type,
    notNull: false,
    pk: false,
    pkPosition: 0,
    default: null,
    unique: false,
    autoIncrement: false,
    ...extra,
  }
}

function table(name: string, columns: ParsedColumn[], tableConstraints: string[] = []): ParsedTable {
  return { name, sql: '', columns, tableConstraints, withoutRowid: false, strict: false }
}

const USERS = table('users', [column('id', 'INTEGER', { pk: true, pkPosition: 1 }), column('name', 'TEXT')])
const ORDERS = table('orders', [
  column('id', 'INTEGER', { pk: true, pkPosition: 1 }),
  column('user_id', 'INTEGER', { references: { table: 'users', column: 'id' } }),
])
const TABLES = [USERS, ORDERS]

const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

let rendered: RenderedElement | null = null

function mount(onOpenData: (name: string) => void = () => undefined, onOpenSchema: (name: string) => void = () => undefined): HTMLElement {
  rendered = renderElement(<ErdView tables={TABLES} onOpenData={onOpenData} onOpenSchema={onOpenSchema} />)
  return rendered.container
}

function node(container: HTMLElement, id: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(`[data-flow-node="${id}"]`)
  if (!element) throw new Error(`missing node ${id}`)
  return element
}

function canvas(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-flow-canvas]')
  if (!element) throw new Error('missing canvas')
  return element
}

function press(element: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
}

function pointer(element: Element, type: string, x: number, y: number): void {
  act(() => {
    element.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: x, clientY: y }),
    )
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve()
  })
}

function restoreUrlMethod(name: 'createObjectURL' | 'revokeObjectURL', original: unknown): void {
  if (original) {
    Object.defineProperty(URL, name, { configurable: true, writable: true, value: original })
  } else {
    delete (URL as unknown as Record<string, unknown>)[name]
  }
}

beforeEach(async () => {
  installTestGlobals()
  await initI18n()
})

afterEach(() => {
  rendered?.unmount()
  rendered = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  restoreUrlMethod('createObjectURL', originalCreateObjectURL)
  restoreUrlMethod('revokeObjectURL', originalRevokeObjectURL)
})

describe('ErdView', () => {
  it('renders one node per table, one edge per foreign key and the schema statistics', () => {
    const container = mount()

    expect(container.querySelectorAll('[data-flow-node]')).toHaveLength(TABLES.length)
    expect(container.querySelectorAll('[data-flow-edge]')).toHaveLength(1)
    expect(container.querySelectorAll('marker#arrow')).toHaveLength(1)
    expect(container.textContent).toContain('users')
    expect(container.textContent).toContain('user_id')

    const orders = node(container, 'orders')
    expect(orders.textContent).toContain('orders')
    expect(orders.textContent).toContain('user_id')
    expect(orders.querySelectorAll('[data-fk="true"]')).toHaveLength(1)
    expect(orders.querySelector('[data-fk="true"]')?.textContent).toContain('user_id')
    expect(node(container, 'users').querySelectorAll('[data-fk="true"]')).toHaveLength(0)

    const stats = container.querySelector('[data-erd-stats]')
    expect(stats?.getAttribute('data-tables')).toBe(String(TABLES.length))
    expect(stats?.getAttribute('data-foreign-keys')).toBe('1')
  })

  it('opens the node context menu and routes the actions to the matching tab openers', () => {
    const openedData: string[] = []
    const openedSchema: string[] = []
    const container = mount(
      (name) => openedData.push(name),
      (name) => openedSchema.push(name),
    )
    const orders = node(container, 'orders')

    act(() => {
      orders.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }))
    })
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual([
      t('development.database.erd.view_data'),
      t('development.database.erd.edit_schema'),
    ])

    act(() => {
      items[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(openedData).toEqual(['orders'])
    expect(document.querySelector('[role="menu"]')).toBeNull()

    act(() => {
      orders.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }))
    })
    const again = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    act(() => {
      again[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(openedSchema).toEqual(['orders'])
  })

  it('moves the focused node with the arrow keys and zooms with the plus and minus keys', () => {
    const container = mount()
    const orders = node(container, 'orders')
    const before = Number.parseFloat(orders.style.left)

    act(() => orders.focus())
    press(orders, 'ArrowRight')
    expect(Number.parseFloat(orders.style.left)).toBe(before + 12)
    press(orders, 'ArrowDown', { shiftKey: true })
    expect(Number.parseFloat(orders.style.top)).toBe(1)

    const view = canvas(container)
    const zoomBefore = Number(view.getAttribute('data-flow-zoom'))
    press(view, '+')
    expect(Number(view.getAttribute('data-flow-zoom'))).toBeCloseTo(zoomBefore * 1.2)
    press(view, '-')
    expect(Number(view.getAttribute('data-flow-zoom'))).toBeCloseTo(zoomBefore)
  })

  it('opens the context menu from the keyboard', () => {
    const container = mount()
    const users = node(container, 'users')

    act(() => users.focus())
    press(users, 'F10', { shiftKey: true })

    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect([...document.querySelectorAll('[role="menuitem"]')]).toHaveLength(2)
  })

  it('pans on background drag and zooms towards the wheel pointer', () => {
    const container = mount()
    const view = canvas(container)
    const layer = container.querySelector<HTMLElement>('[data-flow-node-layer]')

    pointer(view, 'pointerdown', 100, 100)
    pointer(view, 'pointermove', 140, 130)
    pointer(view, 'pointerup', 140, 130)
    expect(layer?.style.transform).toContain('translate(40px,30px)')

    const zoomBefore = Number(view.getAttribute('data-flow-zoom'))
    act(() => {
      view.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, clientX: 40, clientY: 30 }))
    })
    expect(Number(view.getAttribute('data-flow-zoom'))).toBeGreaterThan(zoomBefore)
  })

  it('shows an empty state when the schema has no tables', () => {
    rendered = renderElement(<ErdView tables={[]} />)
    expect(rendered.container.textContent).toContain(t('development.database.erd.empty'))
    expect(rendered.container.querySelectorAll('[data-flow-node]')).toHaveLength(0)
  })
})

describe('SvgFlow PNG export', () => {
  it('exports a self-drawn SVG with one arrow marker and escaped text', async () => {
    const downloads: string[] = []
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:inkstone-erd')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({
      fillStyle: '',
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => {
      callback(new Blob(['png'], { type: 'image/png' }))
    })
    let imageSrc = ''
    class MockImage {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(value: string) {
        imageSrc = value
        queueMicrotask(() => this.onload?.())
      }
    }
    vi.stubGlobal('Image', MockImage)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })

    const escaped = table('a&b', [column('name', 'TEXT<&')])
    const source = table('source', [column('ref', 'INTEGER', { references: { table: 'a&b', column: 'name' } })])
    rendered = renderElement(<ErdView tables={[escaped, source]} />)
    const exportButton = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === t('development.database.flow.export_png'),
    )
    expect(exportButton).toBeTruthy()

    act(() => exportButton?.click())
    await settle()

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(downloads).toEqual(['inkstone-erd.png'])
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('image/png')
    expect(imageSrc.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    const svg = decodeURIComponent(imageSrc.slice(imageSrc.indexOf(',') + 1))
    expect(svg).toContain('a&amp;b')
    expect(svg).toContain('TEXT&lt;&amp;')
    expect(svg.match(/<marker /g)).toHaveLength(1)
    expect(svg).toContain('marker-end="url(#arrow)"')
  })

  it('reports an export failure instead of swallowing it', async () => {
    const onError = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    )
    rendered = renderElement(
      <SvgFlow
        nodes={[{ id: 'a', x: 0, y: 0, width: 100, height: 40 }]}
        edges={[]}
        renderNode={() => <div>a</div>}
        exportNode={() => ({ title: 'a', lines: [] })}
        onError={onError}
        exportName="flow"
      />,
    )
    const exportButton = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === t('development.database.flow.export_png'),
    )
    expect(exportButton).toBeTruthy()

    act(() => exportButton?.click())
    await settle()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(t('development.database.flow.export_failed'))
  })
})
