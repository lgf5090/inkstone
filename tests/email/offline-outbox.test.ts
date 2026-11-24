// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearEmailOfflineDrafts,
  readEmailOfflineDraft,
  removeEmailOfflineDraft,
  saveEmailOfflineDraft,
} from '../../src/client/features/email/offline-outbox'

const fields = { to: 'ada@example.com', cc: '', bcc: '', subject: 'Private', body: 'Draft body' }
const threading = { inReplyTo: null, threadId: null }

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('email offline drafts', () => {
  it('round-trips a draft and removes only its own key', () => {
    saveEmailOfflineDraft('draft:a1:d1', fields, threading)
    expect(readEmailOfflineDraft('draft:a1:d1')).toMatchObject({ key: 'draft:a1:d1', fields, threading })
    removeEmailOfflineDraft('draft:a1:d1')
    expect(readEmailOfflineDraft('draft:a1:d1')).toBeNull()
  })

  it('clears every email draft without touching other local data', () => {
    saveEmailOfflineDraft('draft:a1:d1', fields, threading)
    saveEmailOfflineDraft('new:a1:new:none', fields, threading)
    localStorage.setItem('inkstone.ui', '{}')
    clearEmailOfflineDrafts()
    expect(localStorage.getItem('inkstone:email:offline-draft:v1:draft:a1:d1')).toBeNull()
    expect(localStorage.getItem('inkstone:email:offline-draft:v1:new:a1:new:none')).toBeNull()
    expect(localStorage.getItem('inkstone.ui')).toBe('{}')
  })

  it('reports a corrupt draft instead of trusting its fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    localStorage.setItem('inkstone:email:offline-draft:v1:draft:a1:d1', '{broken')
    expect(readEmailOfflineDraft('draft:a1:d1')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('surfaces a storage refusal instead of claiming the draft is safe', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => saveEmailOfflineDraft('draft:a1:d1', fields, threading)).toThrow('email_offline_draft_write_failed')
    expect(error).toHaveBeenCalledTimes(1)
  })
})
