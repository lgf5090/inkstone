import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMAIL_SAVED_SEARCH_MAX,
  EMAIL_SAVED_SEARCH_NAME_MAX_CHARS,
  EMAIL_SAVED_SEARCH_QUERY_MAX_CHARS,
  parseEmailSavedSearchInput,
  parseEmailSavedSearchPatch,
  type EmailSavedSearchInput,
} from '../../src/shared/email/searches'
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

function createSearch(patch: Partial<EmailSavedSearchInput> = {}) {
  const search = store.createSavedSearch({ name: 'Unread invoices', query: 'from:billing is:unread', ...patch })
  if (!search) throw new Error('saved search was not created')
  return search
}

describe('email saved search contracts', () => {
  it('trims names and queries and accepts the documented limits', () => {
    expect(parseEmailSavedSearchInput({ name: '  Invoices  ', query: '  from:billing  ' })).toEqual({
      name: 'Invoices',
      query: 'from:billing',
    })
    expect(parseEmailSavedSearchInput({
      name: 'x'.repeat(EMAIL_SAVED_SEARCH_NAME_MAX_CHARS),
      query: 'x'.repeat(EMAIL_SAVED_SEARCH_QUERY_MAX_CHARS),
    })).not.toBeNull()
  })

  it('rejects every shape outside the limits', () => {
    const invalid = [
      null,
      [],
      {},
      { name: '' },
      { name: '   ' },
      { name: 'Invoices' },
      { query: 'from:billing' },
      { name: 'Invoices', query: '   ' },
      { name: 'Invoices', query: 1 },
      { name: 'x'.repeat(EMAIL_SAVED_SEARCH_NAME_MAX_CHARS + 1), query: 'from:billing' },
      { name: 'Invoices', query: 'x'.repeat(EMAIL_SAVED_SEARCH_QUERY_MAX_CHARS + 1) },
    ]
    for (const value of invalid) expect(parseEmailSavedSearchInput(value)).toBeNull()
  })

  it('parses partial patches and requires at least one field', () => {
    expect(parseEmailSavedSearchPatch({ name: ' Invoices ' })).toEqual({ name: 'Invoices' })
    expect(parseEmailSavedSearchPatch({ query: ' tag:work ' })).toEqual({ query: 'tag:work' })
    expect(parseEmailSavedSearchPatch({})).toBeNull()
    expect(parseEmailSavedSearchPatch({ name: '' })).toBeNull()
    expect(parseEmailSavedSearchPatch({ query: ' ' })).toBeNull()
    expect(parseEmailSavedSearchPatch({ query: 1 })).toBeNull()
  })
})

describe('email saved searches store', () => {
  it('creates, lists and reads saved searches in creation order', () => {
    const first = createSearch({ name: 'Invoices' })
    const second = createSearch({ name: 'Team mail', query: 'tag:team' })

    expect(first.name).toBe('Invoices')
    expect(first.query).toBe('from:billing is:unread')
    expect(store.getSavedSearch(first.id)?.name).toBe('Invoices')
    expect(store.getSavedSearch('missing')).toBeNull()
    expect(store.listSavedSearches().map((row) => row.id)).toEqual([first.id, second.id])
    expect(store.countSavedSearches()).toBe(2)
  })

  it('refuses invalid and duplicate names regardless of case', () => {
    createSearch({ name: 'Invoices' })
    expect(store.createSavedSearch({ name: 'invoices', query: 'from:billing' })).toBeNull()
    expect(store.createSavedSearch({ name: '   ', query: 'from:billing' })).toBeNull()
    expect(store.createSavedSearch({ name: 'Fresh', query: '   ' })).toBeNull()
    expect(store.createSavedSearch({ name: 'x'.repeat(EMAIL_SAVED_SEARCH_NAME_MAX_CHARS + 1), query: 'q' })).toBeNull()
    expect(store.createSavedSearch({ name: 'Fresh', query: 'x'.repeat(EMAIL_SAVED_SEARCH_QUERY_MAX_CHARS + 1) })).toBeNull()
    expect(store.listSavedSearches()).toHaveLength(1)
  })

  it('updates name and query, allows a case change and refuses another name', () => {
    const first = createSearch({ name: 'Invoices' })
    const second = createSearch({ name: 'Team mail', query: 'tag:team' })

    const renamed = store.updateSavedSearch(first.id, { name: 'INVOICES', query: 'subject:invoice' })
    expect(renamed).toMatchObject({ name: 'INVOICES', query: 'subject:invoice' })
    expect(store.updateSavedSearch(second.id, { name: 'invoices' })).toBeNull()
    expect(store.getSavedSearch(second.id)?.name).toBe('Team mail')
    expect(store.updateSavedSearch(second.id, { name: '  ' })).toBeNull()
    expect(store.updateSavedSearch(second.id, { query: '  ' })).toBeNull()
    expect(store.updateSavedSearch('missing', { name: 'Other' })).toBeNull()
  })

  it('deletes a saved search once', () => {
    const search = createSearch()
    expect(store.deleteSavedSearch(search.id)).toBe(true)
    expect(store.deleteSavedSearch(search.id)).toBe(false)
    expect(store.listSavedSearches()).toEqual([])
  })

  it('stops at the saved search limit until one is removed', () => {
    for (let index = 0; index < EMAIL_SAVED_SEARCH_MAX; index += 1) {
      createSearch({ name: `Search ${String(index).padStart(3, '0')}` })
    }
    expect(store.countSavedSearches()).toBe(EMAIL_SAVED_SEARCH_MAX)
    expect(store.createSavedSearch({ name: 'One more', query: 'is:unread' })).toBeNull()

    const first = store.listSavedSearches()[0]!
    expect(store.deleteSavedSearch(first.id)).toBe(true)
    expect(store.createSavedSearch({ name: 'One more', query: 'is:unread' })).not.toBeNull()
  })

  it('clears saved searches with the mailbox', () => {
    createSearch()
    store.deleteAll()
    expect(store.listSavedSearches()).toEqual([])
  })

  it('records the migration and its case-insensitive unique index', () => {
    const migration = sqlite
      .prepare(`SELECT name FROM email_migrations WHERE name = '8_saved_searches'`)
      .all()
    expect(migration).toHaveLength(1)
    const indexes = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_email_saved_searches_name'`)
      .all()
    expect(indexes).toHaveLength(1)
  })
})
