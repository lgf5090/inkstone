import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectBoardMember, ProjectMinimumRole } from '@shared/project/model'
import { PROJECT_LIMITS } from '@shared/project/limits'
import { initI18n, t } from '../../lib/i18n'
import { renderElement, type RenderedElement } from '../../lib/test-render'
import { MembersDialog } from './MembersDialog'
import * as api from './api'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  fetchBoardMembers: vi.fn(),
  addBoardMember: vi.fn(),
  setBoardMemberRole: vi.fn(),
  removeBoardMember: vi.fn(),
}))

const member = (userId: string, role: ProjectBoardMember['role']): ProjectBoardMember => ({ boardId: 'b1', userId, role, createdAt: 1, updatedAt: 1 })

let view: RenderedElement
type PatchFn = (patch: { type?: 'O' | 'P', minimumRole?: ProjectMinimumRole }) => Promise<void>
let onBoardPatched: ReturnType<typeof vi.fn<PatchFn>>

async function mount(members: ProjectBoardMember[], boardType: 'O' | 'P' = 'P'): Promise<void> {
  vi.mocked(api.fetchBoardMembers).mockResolvedValue(members)
  onBoardPatched = vi.fn<PatchFn>().mockResolvedValue(undefined)
  await act(async () => {
    view = renderElement(createElement(MembersDialog, { boardId: 'b1', boardType, minimumRole: '', onClose: vi.fn(), onBoardPatched }))
  })
}

beforeEach(async () => { vi.clearAllMocks(); await initI18n() })
afterEach(() => { view?.unmount() })

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('the members dialog (R3-4)', () => {
  it('lists every member with a role picker', async () => {
    await mount([member('alice', 'admin'), member('bob', 'editor')])
    const rows = [...document.querySelectorAll('[data-board-member]')]
    expect(rows.map((row) => row.getAttribute('data-board-member'))).toEqual(['alice', 'bob'])
    expect(document.querySelector(`button[aria-label="${t('project.members.role')}: bob"]`)?.textContent).toBe(t('project.role.editor'))
  })

  it('invites the typed account with the chosen role', async () => {
    vi.mocked(api.addBoardMember).mockResolvedValue(member('carol', 'editor'))
    await mount([member('alice', 'admin')])
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${t('project.members.user_id')}"]`)!
    await act(async () => { setInput(field, 'carol') })
    await act(async () => { field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(api.addBoardMember).toHaveBeenCalledWith('b1', 'carol', 'editor')
  })

  it('refuses to demote or remove the only admin', async () => {
    await mount([member('alice', 'admin'), member('bob', 'editor')])
    const aliceRole = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.members.role')}: alice"]`)!
    const aliceRemove = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.members.remove')}: alice"]`)!
    expect(aliceRole.disabled).toBe(true)
    expect(aliceRemove.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.members.role')}: bob"]`)!.disabled).toBe(false)
  })

  it('lets a second admin be demoted once there are two', async () => {
    await mount([member('alice', 'admin'), member('bob', 'admin')])
    expect(document.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.members.role')}: alice"]`)!.disabled).toBe(false)
  })

  it('stops inviting once the roster is full', async () => {
    const roster = Array.from({ length: PROJECT_LIMITS.boardMembers }, (_, index) => member(`u${index}`, index === 0 ? 'admin' : 'viewer'))
    await mount(roster)
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${t('project.members.user_id')}"]`)!
    await act(async () => { setInput(field, 'one-too-many') })
    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === t('project.members.add'))
    expect(add!.disabled, 'a full roster still accepts an invite').toBe(true)
    expect(document.querySelector('[role="status"]')?.textContent).toContain(String(PROJECT_LIMITS.boardMembers))
  })

  it('patches the board visibility and offers the default role only when open', async () => {
    await mount([member('alice', 'admin')], 'P')
    expect(document.querySelector(`button[aria-label="${t('project.board.minimum_role')}"]`)).toBeNull()
    const visibility = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('project.board.visibility')}"]`)!
    await act(async () => { visibility.click() })
    const open = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"], [role="menuitem"]')].find((row) => row.textContent === t('project.board.open'))
    await act(async () => { open!.click() })
    expect(onBoardPatched).toHaveBeenCalledWith({ type: 'O' })
  })
})
describe('a refused invite', () => {
  it('surfaces the server refusal instead of failing silently', async () => {
    vi.mocked(api.addBoardMember).mockRejectedValue(new Error('User not found'))
    await mount([member('alice', 'admin')])
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${t('project.members.user_id')}"]`)!
    await act(async () => { setInput(field, 'ghost') })
    await act(async () => { field.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    const { useUi } = await import('../../store/ui')
    expect(useUi.getState().toasts.map((toast) => toast.title)).toContain('User not found')
    expect(useUi.getState().toasts.some((toast) => toast.tone === 'danger')).toBe(true)
  })
})
