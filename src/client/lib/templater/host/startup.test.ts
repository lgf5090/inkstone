import { describe, expect, it, vi } from 'vitest'
import { runStartupTemplates, type StartupPorts } from './startup'
import type { TemplaterErrorCode } from '../errors'

/** The batch, driven by a port that records what it was asked and can be told how to answer. */
function batch(
  answers: Record<string, { ok: boolean; code?: TemplaterErrorCode; detail?: string } | 'throw'> = {},
): { ports: StartupPorts; asked: string[]; order: string[] } {
  const asked: string[] = []
  const order: string[] = []
  return {
    asked,
    order,
    ports: {
      async run(templateId) {
        asked.push(templateId)
        // A gap the caller cannot close: the batch's promise is serial, so no two entries may be in flight
        // at once. This records when each run *started* relative to the others finishing.
        order.push(`start:${templateId}`)
        const answer = answers[templateId]
        if (answer === 'throw') throw new Error('the store exploded')
        const settled = answer ?? { ok: true }
        await Promise.resolve()
        order.push(`end:${templateId}`)
        return settled
      },
    },
  }
}

describe('runStartupTemplates', () => {
  it('asks for nothing when the reader listed nothing', async () => {
    const fake = batch()
    expect(await runStartupTemplates([], fake.ports)).toEqual([])
    expect(fake.asked).toEqual([])
  })

  it('runs the list in the order the reader wrote it, one at a time', async () => {
    const fake = batch()
    const outcomes = await runStartupTemplates(['tpl-b', 'tpl-a', 'tpl-c'], fake.ports)
    expect(fake.asked).toEqual(['tpl-b', 'tpl-a', 'tpl-c'])
    expect(fake.order).toEqual(['start:tpl-b', 'end:tpl-b', 'start:tpl-a', 'end:tpl-a', 'start:tpl-c', 'end:tpl-c'])
    expect(outcomes.map((outcome) => outcome.templateId)).toEqual(['tpl-b', 'tpl-a', 'tpl-c'])
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true)
  })

  it('runs one template once even if the list names it twice, and skips blanks', async () => {
    const fake = batch()
    const outcomes = await runStartupTemplates(['tpl-a', '  ', 'tpl-a', 'tpl-b', ''], fake.ports)
    expect(fake.asked).toEqual(['tpl-a', 'tpl-b'])
    expect(outcomes.map((outcome) => outcome.templateId)).toEqual(['tpl-a', 'tpl-b'])
  })

  it('keeps going after a refusal and reports each one separately', async () => {
    const fake = batch({
      'tpl-bad': { ok: false, code: 'sandbox-unavailable', detail: 'worker-dead' },
      'tpl-missing': { ok: false, code: 'note-not-found', detail: 'tpl-missing' },
    })
    const outcomes = await runStartupTemplates(['tpl-bad', 'tpl-ok', 'tpl-missing'], fake.ports)
    expect(fake.asked).toEqual(['tpl-bad', 'tpl-ok', 'tpl-missing'])
    expect(outcomes).toEqual([
      { templateId: 'tpl-bad', ok: false, code: 'sandbox-unavailable', detail: 'worker-dead' },
      { templateId: 'tpl-ok', ok: true },
      { templateId: 'tpl-missing', ok: false, code: 'note-not-found', detail: 'tpl-missing' },
    ])
  })

  it('folds a port that throws into the same answer shape, so the batch still finishes', async () => {
    const thrown = vi.fn()
    const ports: StartupPorts = {
      async run(templateId) {
        if (templateId === 'tpl-boom') throw new Error('  api\n  failed  ')
        thrown()
        return { ok: true }
      },
    }
    const outcomes = await runStartupTemplates(['tpl-boom', 'tpl-after'], ports)
    expect(outcomes[0]).toEqual({ templateId: 'tpl-boom', ok: false, code: 'render-failed', detail: 'api failed' })
    expect(outcomes[1]).toEqual({ templateId: 'tpl-after', ok: true })
    expect(thrown).toHaveBeenCalledOnce()
  })

  it('keeps a thrown message to one readable line', async () => {
    const ports: StartupPorts = {
      async run() {
        throw new Error(`line ${'x'.repeat(300)}`)
      },
    }
    const [outcome] = await runStartupTemplates(['tpl-long'], ports)
    expect(outcome!.detail!.length).toBeLessThanOrEqual(120)
    expect(outcome!.detail).not.toContain('\n')
  })

  it('answers with what it was given for a throw that carries no message', async () => {
    const ports: StartupPorts = {
      async run() {
        throw null
      },
    }
    const [outcome] = await runStartupTemplates(['tpl-null'], ports)
    expect(outcome).toEqual({ templateId: 'tpl-null', ok: false, code: 'render-failed', detail: 'null' })
  })
})
