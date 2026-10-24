import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMAIL_TEMPLATE_BODY_MAX_CHARS,
  EMAIL_TEMPLATE_MAX,
  EMAIL_TEMPLATE_NAME_MAX_CHARS,
  EMAIL_TEMPLATE_SUBJECT_MAX_CHARS,
  parseEmailTemplateInput,
  parseEmailTemplatePatch,
  type EmailTemplateInput,
} from '../../src/shared/email/templates'
import { applyMailboxMigrations } from '../../src/worker/email/mailbox-schema'
import { MailboxStore } from '../../src/worker/email/mailbox-store'
import { makeSqlExec } from '../doubles/do-sqlite'

let sqlite: DatabaseSync
let store: MailboxStore

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  const sql = makeSqlExec(sqlite)
  applyMailboxMigrations(sql)
  store = new MailboxStore(sql)
})

function createTemplate(patch: Partial<EmailTemplateInput> = {}) {
  const template = store.createTemplate({
    name: 'Welcome',
    subject: 'Hello',
    body: 'Hi there',
    ...patch,
  })
  if (!template) throw new Error('template was not created')
  return template
}

describe('email template contracts', () => {
  it('accepts a full template and trims the name and subject', () => {
    expect(parseEmailTemplateInput({
      name: '  Welcome  ',
      subject: '  Hello  ',
      body: 'Hi there\n',
    })).toEqual({
      name: 'Welcome',
      subject: 'Hello',
      body: 'Hi there\n',
    })
    expect(parseEmailTemplateInput({ name: 'Welcome' })).toEqual({
      name: 'Welcome',
      subject: '',
      body: '',
    })
  })

  it('rejects every shape outside the limits', () => {
    const invalid = [
      null,
      [],
      {},
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(EMAIL_TEMPLATE_NAME_MAX_CHARS + 1) },
      { name: 'Welcome', subject: 'x'.repeat(EMAIL_TEMPLATE_SUBJECT_MAX_CHARS + 1) },
      { name: 'Welcome', body: 'x'.repeat(EMAIL_TEMPLATE_BODY_MAX_CHARS + 1) },
      { name: 'Welcome', subject: 1 },
      { name: 'Welcome', body: [] },
    ]
    for (const value of invalid) expect(parseEmailTemplateInput(value)).toBeNull()
    expect(parseEmailTemplateInput({
      name: 'Welcome',
      subject: 'x'.repeat(EMAIL_TEMPLATE_SUBJECT_MAX_CHARS),
      body: 'x'.repeat(EMAIL_TEMPLATE_BODY_MAX_CHARS),
    })).not.toBeNull()
  })

  it('parses partial patches and requires at least one field', () => {
    expect(parseEmailTemplatePatch({ subject: ' Hello ' })).toEqual({ subject: 'Hello' })
    expect(parseEmailTemplatePatch({ body: '' })).toEqual({ body: '' })
    expect(parseEmailTemplatePatch({ name: ' Welcome ' })).toEqual({ name: 'Welcome' })
    expect(parseEmailTemplatePatch({})).toBeNull()
    expect(parseEmailTemplatePatch({ subject: 1 })).toBeNull()
    expect(parseEmailTemplatePatch({ name: '' })).toBeNull()
  })
})

describe('email templates store', () => {
  it('creates, lists and reads templates in name order', () => {
    const welcome = createTemplate({ name: 'Welcome' })
    createTemplate({ name: 'Beta' })
    createTemplate({ name: 'alpha' })

    expect(welcome.subject).toBe('Hello')
    expect(welcome.body).toBe('Hi there')
    expect(store.getTemplate(welcome.id)?.name).toBe('Welcome')
    expect(store.getTemplate('missing')).toBeNull()
    expect(store.listTemplates().map((row) => row.name)).toEqual(['alpha', 'Beta', 'Welcome'])
  })

  it('refuses a duplicate name regardless of case', () => {
    createTemplate({ name: 'Welcome' })
    expect(store.createTemplate({ name: 'welcome', subject: '', body: '' })).toBeNull()
    expect(store.listTemplates()).toHaveLength(1)
  })

  it('updates fields, allows a case change and refuses another template name', () => {
    const first = createTemplate({ name: 'Welcome' })
    const second = createTemplate({ name: 'Beta', subject: 'Old', body: 'Old body' })

    const updated = store.updateTemplate(first.id, { name: 'WELCOME', subject: 'New', body: 'New body' })
    expect(updated).toMatchObject({ name: 'WELCOME', subject: 'New', body: 'New body' })
    expect(updated!.updated_at).toBeGreaterThanOrEqual(updated!.created_at)

    expect(store.updateTemplate(second.id, { name: 'welcome' })).toBeNull()
    expect(store.getTemplate(second.id)?.name).toBe('Beta')
    expect(store.updateTemplate('missing', { subject: 'x' })).toBeNull()
  })

  it('deletes a template once', () => {
    const template = createTemplate()
    expect(store.deleteTemplate(template.id)).toBe(true)
    expect(store.deleteTemplate(template.id)).toBe(false)
    expect(store.listTemplates()).toEqual([])
  })

  it('stops at the template limit until one is removed', () => {
    for (let index = 0; index < EMAIL_TEMPLATE_MAX; index += 1) {
      createTemplate({ name: `Template ${String(index).padStart(3, '0')}` })
    }
    expect(store.countTemplates()).toBe(EMAIL_TEMPLATE_MAX)
    expect(store.createTemplate({ name: 'One more', subject: '', body: '' })).toBeNull()

    const first = store.listTemplates()[0]!
    expect(store.deleteTemplate(first.id)).toBe(true)
    expect(store.createTemplate({ name: 'One more', subject: '', body: '' })).not.toBeNull()
  })

  it('clears templates with the mailbox', () => {
    createTemplate()
    store.deleteAll()
    expect(store.listTemplates()).toEqual([])
  })
})
