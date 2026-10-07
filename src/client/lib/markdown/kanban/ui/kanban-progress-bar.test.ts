import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n, t } from '../../../i18n'
import { installTestGlobals } from '../../../test-render'
import type { KanbanItem, KanbanProperty } from '../types'
import { KanbanProgressBar } from './kanban-progress-bar'

beforeAll(async () => {
  await initI18n()
})

const statusColumn: KanbanProperty = {
  id: 'status',
  name: 'Status',
  type: 'select',
  options: [
    { id: 'todo', label: 'To Do', color: 'gray' },
    { id: 'done', label: 'Done', color: 'green' },
  ],
}

function card(id: string, status?: string): KanbanItem {
  return { id, title: id, properties: status ? { status } : {} }
}

function mountBar(items: KanbanItem[]) {
  installTestGlobals()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(createElement(KanbanProgressBar, { items, statusColumn }))
  })
  return { container, root }
}

describe('KanbanProgressBar accessibility', () => {
  it('names the bar with the status distribution instead of leaving painted divs silent', () => {
    const { container, root } = mountBar([card('a', 'todo'), card('b', 'todo'), card('c', 'done'), card('d')])
    const bar = container.querySelector('[role="img"]')
    expect(bar?.getAttribute('aria-label')).toBe(
      t('preview.kanban_status_summary', {
        summary: ['To Do 2', 'Done 1', `${t('preview.kanban_status_other')} 1`].join(', '),
      }),
    )
    act(() => root.unmount())
  })

  it('reads the segments as presentational, so a screen reader hears one name, not four divs', () => {
    const { container, root } = mountBar([card('a', 'todo'), card('b', 'done')])
    const segments = container.querySelectorAll('[role="img"] > div')
    expect(segments.length).toBe(2)
    segments.forEach((segment) => expect(segment.getAttribute('aria-hidden')).toBe('true'))
    act(() => root.unmount())
  })
})
