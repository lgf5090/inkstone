import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n, t } from '../../../../lib/i18n'
import { installTestGlobals } from '../../../test-render'
import { KanbanGanttView } from './kanban-gantt-view'
import type { KanbanData, KanbanItem, KanbanView } from '../types'

beforeAll(async () => {
  await initI18n()
})

const task: KanbanItem = {
  id: 't-1',
  title: 'Draft plan',
  properties: {
    startDate: '2026-09-16',
    endDate: '2026-09-22',
    progress: 50,
  },
}

function renderGantt(item: KanbanItem = task, view?: KanbanView) {
  installTestGlobals()
  const data: KanbanData = { views: [], columns: [], items: [item] }
  const onOpenDetail = vi.fn()
  const onAddItem = vi.fn()
  const onUpdateProgress = vi.fn()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(KanbanGanttView, {
      data,
      view,
      onOpenDetail,
      onAddItem,
      onUpdateProgress,
      onReschedule: vi.fn(),
    }))
  })
  return { container, root, onOpenDetail, onUpdateProgress }
}

function setSliderValue(slider: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(slider, value)
  slider.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('kanban gantt progress control', () => {
  it('exposes a keyboard-operable slider per task reflecting stored progress', () => {
    const { container, root } = renderGantt()
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider.getAttribute('aria-label')).toBe(t('preview.kanban_progress'))
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('100')
    expect(slider.value).toBe('50')
    act(() => root.unmount())
    container.remove()
  })

  it('holds a drag as a draft and commits once, on release, as a clamped number', () => {
    const { container, root, onUpdateProgress } = renderGantt()
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
    // Two change events: a per-step commit would have written twice and spent two undo steps.
    act(() => {
      setSliderValue(slider, '55')
      setSliderValue(slider, '75')
    })
    expect(onUpdateProgress, 'the drag itself must not write').not.toHaveBeenCalled()
    act(() => {
      slider.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(onUpdateProgress).toHaveBeenCalledTimes(1)
    expect(onUpdateProgress).toHaveBeenCalledWith('t-1', 75)
    act(() => root.unmount())
    container.remove()
  })

  it('commits a keyboard run on key up, once for the whole run', () => {
    const { container, root, onUpdateProgress } = renderGantt()
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
    act(() => {
      setSliderValue(slider, '25')
      setSliderValue(slider, '30')
    })
    act(() => {
      slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))
    })
    expect(onUpdateProgress).toHaveBeenCalledTimes(1)
    expect(onUpdateProgress).toHaveBeenCalledWith('t-1', 30)
    act(() => root.unmount())
    container.remove()
  })

  it('does not mutate progress through a hidden double-click cycle', () => {
    const { container, root, onOpenDetail, onUpdateProgress } = renderGantt()
    const bar = container.querySelector<HTMLElement>('[data-item-id="t-1"]')!
    act(() => {
      bar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onOpenDetail).toHaveBeenCalledTimes(1)
    expect(onUpdateProgress).not.toHaveBeenCalled()
    act(() => root.unmount())
    container.remove()
  })

  it('shows progress stored under the view-configured progress field', () => {
    const item: KanbanItem = {
      id: 't-cfg',
      title: 'Configured progress',
      properties: { startDate: '2026-09-16', endDate: '2026-09-22', completionRate: 80 },
    }
    const view: KanbanView = { id: 'v', name: 'G', type: 'gantt', progressField: 'completionRate' }
    const { container, root } = renderGantt(item, view)
    const slider = container.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider.value).toBe('80')
    act(() => root.unmount())
    container.remove()
  })
})
