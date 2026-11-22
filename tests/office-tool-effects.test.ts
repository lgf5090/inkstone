// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeEditPlan } from '../src/shared/office/ai'
import type { ToolActivity } from '../src/shared/assistant'
import { registerOfficeEditorHandle } from '../src/client/features/office/editor/handles'
import { runPendingOfficeEffects } from '../src/client/features/office/ai/use-tool-effects'

const FILE_ID = '0123456789abcdefghjkmnpqrs'

function plan(): OfficeEditPlan {
  return {
    type: 'docs',
    fileId: FILE_ID,
    summary: 'Add a paragraph',
    ops: [{ kind: 'docs.append-paragraph', text: 'Hello' }],
  }
}

function tool(id: string, effect: NonNullable<ToolActivity['effect']>): ToolActivity {
  return { id, name: 'office_propose_edit', status: 'success', effect }
}

describe('office tool effects', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.history.replaceState(null, '', '/office')
  })

  it('applies a plan once through the registered editor handle', async () => {
    const applyPlan = vi.fn(async () => {})
    const flush = vi.fn(async () => {})
    const undo = vi.fn()
    registerOfficeEditorHandle(FILE_ID, {
      save: () => ({}),
      flush,
      undo,
      applyPlan,
      context: () => ({}),
    })

    const activity = tool('a-apply-once', {
      kind: 'office.apply-plan',
      fileId: FILE_ID,
      fileType: 'docs',
      plan: plan(),
    })
    await runPendingOfficeEffects({ tools: [activity] }, false)
    await runPendingOfficeEffects({ tools: [activity] }, false)

    expect(applyPlan).toHaveBeenCalledTimes(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(undo).not.toHaveBeenCalled()
    expect(window.location.pathname).toBe(`/office/docs/${FILE_ID}`)
  })

  it('dispatches a refresh once and ignores a turn that is still streaming', async () => {
    const listener = vi.fn()
    window.addEventListener('office:refresh', listener)
    const activity = tool('a-refresh-once', { kind: 'office.refresh' })
    await runPendingOfficeEffects({ tools: [activity] }, true)
    expect(listener).not.toHaveBeenCalled()
    await runPendingOfficeEffects({ tools: [activity] }, false)
    await runPendingOfficeEffects({ tools: [activity] }, false)
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener('office:refresh', listener)
  })

  it('stops after a failed application instead of running later effects', async () => {
    const applyPlan = vi.fn(async () => { throw new Error('boom') })
    registerOfficeEditorHandle(FILE_ID, {
      save: () => ({}),
      flush: async () => {},
      undo: () => {},
      applyPlan,
      context: () => ({}),
    })
    const listener = vi.fn()
    window.addEventListener('office:refresh', listener)
    await runPendingOfficeEffects({
      tools: [
        tool('a-fail', { kind: 'office.apply-plan', fileId: FILE_ID, fileType: 'docs', plan: plan() }),
        tool('a-after-fail', { kind: 'office.refresh' }),
      ],
    }, false)
    expect(applyPlan).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener('office:refresh', listener)
  })
})