import { beforeAll, describe, expect, it } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import { EN_US_NOTE_TEMPLATE_CONTENT } from '@shared/locales/en-US-note-template-content'
import { ZH_CN_NOTE_TEMPLATE_CONTENT } from '@shared/locales/zh-CN-note-template-content'
import type { MessageKey } from '@shared/locales/en-US'
import { ensureNoteTemplateContentLoaded, initI18n, setLocaleAsync, t } from './i18n'

const DIARY = 'template.diary.content' as MessageKey
const enBodies = EN_US_NOTE_TEMPLATE_CONTENT as Record<string, string>
const zhBodies = ZH_CN_NOTE_TEMPLATE_CONTENT as Record<string, string>

describe('note template bodies load on demand', () => {
  beforeAll(async () => {
    await initI18n()
  })

  it('keeps the bodies out of the catalog the start-up chunk loads', () => {
    expect(DIARY in EN_US_MESSAGES).toBe(false)
    expect(Object.keys(EN_US_NOTE_TEMPLATE_CONTENT).length).toBe(38)
    expect(Object.keys(ZH_CN_NOTE_TEMPLATE_CONTENT).length).toBe(38)
  })

  it('resolves a body only once the bodies have been loaded', async () => {
    expect(t(DIARY)).toBe(DIARY)
    await ensureNoteTemplateContentLoaded()
    const body = t(DIARY)
    expect(body).not.toBe(DIARY)
    expect(body.startsWith('---')).toBe(true)
    expect(body).toContain('{{title}}')
  })

  it('resolves the body in the language the reader is actually reading', async () => {
    await setLocaleAsync('zh-CN', false)
    await ensureNoteTemplateContentLoaded()
    const chinese = t(DIARY)
    expect(chinese).toBe(zhBodies[DIARY])
    expect(chinese).not.toBe(enBodies[DIARY])
    await setLocaleAsync('en-US', false)
  })

  it('settles the same answer for every template the catalog names', async () => {
    await ensureNoteTemplateContentLoaded()
    for (const key of Object.keys(EN_US_NOTE_TEMPLATE_CONTENT) as MessageKey[])
      expect(t(key), key).toBe(enBodies[key])
  })
})
