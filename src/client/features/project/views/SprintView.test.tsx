import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectCard } from '@shared/project/model'
import type { ProjectSprint, ProjectSprintBurndown } from '@shared/project/stats'
import { initI18n, t } from '../../../lib/i18n'
import { renderElement } from '../../../lib/test-render'
import { SprintView } from './SprintView'
import * as api from '../api'

const stamps = { createdBy: 'u1', modifiedBy: 'u1', createAt: 1, updateAt: 1, deleteAt: 0 }

const sprint: ProjectSprint = {
  id: 'r1', boardId: 'b1', name: 'Sprint 1', goal: '',
  startAt: new Date(2026, 10, 9).getTime(), endAt: new Date(2026, 10, 12).getTime(),
  status: 'active', createdBy: 'u1', createdAt: 1, updatedAt: 1,
}

const card: ProjectCard = {
  id: 'c1', boardId: 'b1', parentId: '', title: 'Write the report', icon: '',
  isTemplate: false, contentOrder: [], values: {}, ...stamps,
}

const burndown: ProjectSprintBurndown = {
  total: 1, completed: 0, remaining: 1, velocity: 0,
  points: [
    { day: 1, dayLabel: '2026-11-09', ideal: 1, remaining: 1, completed: 0 },
    { day: 2, dayLabel: '2026-11-10', ideal: 0.7, remaining: 1, completed: 0 },
  ],
}

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve() }) }

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

let mounted: ReturnType<typeof renderElement> | undefined

async function open(): Promise<void> {
  await act(async () => {
    mounted = renderElement(createElement(SprintView, { boardId: 'b1', cards: [card], canEdit: true, onOpenCard: vi.fn() }))
  })
  await flush()
}

beforeEach(async () => {
  document.body.innerHTML = ''
  await initI18n()
  vi.spyOn(api, 'fetchProjectSprints').mockResolvedValue([sprint])
  vi.spyOn(api, 'fetchProjectSprintDetail').mockResolvedValue({ sprint, cards: [card], burndown })
  vi.spyOn(api, 'createProjectSprint').mockResolvedValue(sprint)
  vi.spyOn(api, 'assignCardToSprint').mockResolvedValue(undefined)
  vi.spyOn(api, 'removeCardFromSprint').mockResolvedValue(undefined)
  vi.spyOn(api, 'patchProjectSprint').mockResolvedValue(sprint)
  vi.spyOn(api, 'deleteProjectSprint').mockResolvedValue(undefined)
})

afterEach(() => {
  mounted?.unmount()
  document.body.innerHTML = ''
})

describe('the sprint view', () => {
  it('names the burndown for a reader and lists the sprint cards', async () => {
    await open()
    expect(document.body.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe(
      t('project.sprint.chart_label', { total: 1, completed: 0 }),
    )
    expect(document.body.querySelectorAll('table tbody tr')).toHaveLength(2)
    expect(document.body.textContent).toContain('Write the report')
  })

  it('creates a sprint with the typed dates', async () => {
    await open()
    const name = document.body.querySelector<HTMLInputElement>(`input[aria-label="${t('project.sprint.name')}"]`)!
    await act(async () => { setInput(name, 'Sprint 2') })
    const create = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.includes(t('project.sprint.create')))!
    await act(async () => { create.click() })
    await flush()
    expect(api.createProjectSprint).toHaveBeenCalledWith('b1', expect.objectContaining({ name: 'Sprint 2', status: 'planned' }))
  })

  it('shows a load failure with a retry instead of an empty sprint list', async () => {
    vi.mocked(api.fetchProjectSprints).mockRejectedValueOnce(new Error('offline'))
    await open()
    expect(document.body.textContent).toContain(t('project.sprint.load_failed'))
    expect(document.body.textContent).toContain(t('common.retry'))
  })
})
