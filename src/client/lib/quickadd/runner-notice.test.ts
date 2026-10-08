import { beforeAll, describe, expect, it } from 'vitest'
import { newCaptureChoice } from '@shared/quickadd'
import { initI18n, t } from '../../lib/i18n'
import { runNotice } from './runner'
import type { QuickAddRunStatus } from './context'

const choice = newCaptureChoice('qa-c', 'Inbox capture', 0)
const both = { notifications: true, cancelNotice: true }

beforeAll(async () => {
  await initI18n()
})

describe('what a finished run says about itself', () => {
  it('names the note a write landed in', () => {
    const written: QuickAddRunStatus = { kind: 'written', noteId: 'n1', created: false, summary: 'Inbox capture wrote into Inbox' }
    expect(runNotice(written, choice, both)?.title).toBe('Inbox capture wrote into Inbox')
    expect(runNotice(written, choice, { ...both, notifications: false })).toBeNull()
  })

  it('says the run had nothing to write only when notices are on', () => {
    const empty: QuickAddRunStatus = { kind: 'empty', noteId: 'n1' }
    expect(runNotice(empty, choice, both)?.title).toBe(t('quickadd.ran_empty', { name: choice.name }))
    expect(runNotice(empty, choice, { ...both, notifications: false })).toBeNull()
  })

  it('keeps a plain cancelled run silent unless the cancellation notice is on', () => {
    expect(runNotice({ kind: 'cancelled' }, choice, { notifications: true, cancelNotice: false })).toBeNull()
    expect(runNotice({ kind: 'cancelled' }, choice, both)?.title).toBe(t('quickadd.ran_cancelled', { name: choice.name }))
  })

  it('always reports a cancel the engine refused, and a failure, whatever the switches say', () => {
    const refused = runNotice({ kind: 'cancelled', reason: 'gone' }, choice, { notifications: false, cancelNotice: false })
    expect(refused).toEqual({ title: 'gone', tone: 'warning' })
    const failed = runNotice({ kind: 'failed', reason: 'no target' }, choice, { notifications: false, cancelNotice: false })
    expect(failed?.title).toBe('no target')
    expect(failed?.tone).toBe('danger')
    expect(failed?.description).toContain(choice.name)
  })
})
