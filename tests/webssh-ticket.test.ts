// @vitest-environment node
// W2 one-time ticket: origin binding, single use, expiry and per-owner isolation, against a real
// SQLite database behind the D1 double.

import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeD1 } from './doubles/d1-sqlite'
import {
  consumeTicket,
  createTicketToken,
  isCanonicalOrigin,
  issueTicket,
  ticketId,
  ticketOrigin,
  WEBSSH_TICKET_TOKEN_MAX_LENGTH,
} from '../src/worker/webssh/session-ticket'
import { newId } from '../src/worker/lib/id'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(`
    CREATE TABLE webssh_session_tickets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      consumed_at INTEGER
    );
  `)
  db = makeD1(sqlite)
})

afterEach(() => {
  sqlite.close()
})

describe('ticket token', () => {
  it('carries a canonical origin and refuses a token whose origin was changed', () => {
    const token = createTicketToken('https://notes.example.com')
    expect(ticketOrigin(token)).toBe('https://notes.example.com')
    const tampered = token.replace(/\.([^.]*)$/, '.aHR0cHM6Ly9ldmlsLmV4YW1wbGUuY29t')
    expect(ticketOrigin(tampered)).toBe('https://evil.example.com')
    expect(ticketId(token)).toBeDefined()
  })

  it('accepts only a scheme-host-port origin', () => {
    expect(isCanonicalOrigin('https://notes.example.com')).toBe(true)
    expect(isCanonicalOrigin('http://localhost:7712')).toBe(true)
    expect(isCanonicalOrigin('https://notes.example.com/')).toBe(false)
    expect(isCanonicalOrigin('https://notes.example.com/path')).toBe(false)
    expect(isCanonicalOrigin('https://user:pass@notes.example.com')).toBe(false)
    expect(isCanonicalOrigin('not an origin')).toBe(false)
  })

  it('hashes the token to the 43-character database id', async () => {
    const token = createTicketToken('https://notes.example.com')
    const id = await ticketId(token)
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('issue and consume', () => {
  it('consumes a ticket once and then reports it as consumed', async () => {
    const userId = newId()
    const sessionId = newId()
    const now = 1_000_000
    const ticket = await issueTicket(db, { userId, sessionId, origin: 'https://notes.example.com', now })

    await expect(consumeTicket(db, {
      userId, sessionId, token: ticket.token, origin: 'https://notes.example.com', now: now + 1,
    })).resolves.toBe('ok')
    await expect(consumeTicket(db, {
      userId, sessionId, token: ticket.token, origin: 'https://notes.example.com', now: now + 2,
    })).resolves.toBe('consumed')
  })

  it('refuses an expired ticket', async () => {
    const userId = newId()
    const sessionId = newId()
    const now = 1_000_000
    const ticket = await issueTicket(db, { userId, sessionId, origin: 'https://notes.example.com', now })
    await expect(consumeTicket(db, {
      userId, sessionId, token: ticket.token, origin: 'https://notes.example.com', now: ticket.expiresAt + 1,
    })).resolves.toBe('expired')
  })

  it('refuses a ticket presented from another origin without burning it', async () => {
    const userId = newId()
    const sessionId = newId()
    const now = 1_000_000
    const ticket = await issueTicket(db, { userId, sessionId, origin: 'https://notes.example.com', now })
    await expect(consumeTicket(db, {
      userId, sessionId, token: ticket.token, origin: 'https://evil.example.com', now: now + 1,
    })).resolves.toBe('origin_mismatch')
    await expect(consumeTicket(db, {
      userId, sessionId, token: ticket.token, origin: 'https://notes.example.com', now: now + 2,
    })).resolves.toBe('ok')
  })

  it('does not let another user or session use a ticket', async () => {
    const userId = newId()
    const sessionId = newId()
    const ticket = await issueTicket(db, { userId, sessionId, origin: 'https://notes.example.com', now: 1_000_000 })
    await expect(consumeTicket(db, {
      userId: newId(), sessionId, token: ticket.token, origin: 'https://notes.example.com', now: 1_000_001,
    })).resolves.toBe('missing')
    await expect(consumeTicket(db, {
      userId, sessionId: newId(), token: ticket.token, origin: 'https://notes.example.com', now: 1_000_001,
    })).resolves.toBe('missing')
  })

  it('refuses an oversized or malformed token', async () => {
    const userId = newId()
    const sessionId = newId()
    await expect(consumeTicket(db, {
      userId, sessionId, token: 'x'.repeat(WEBSSH_TICKET_TOKEN_MAX_LENGTH + 1), origin: 'https://notes.example.com',
    })).resolves.toBe('missing')
    await expect(consumeTicket(db, {
      userId, sessionId, token: 'not-a-ticket', origin: 'https://notes.example.com',
    })).resolves.toBe('missing')
  })

  it('clears consumed and expired rows before issuing the next ticket', async () => {
    const userId = newId()
    const sessionId = newId()
    const now = 1_000_000
    const first = await issueTicket(db, { userId, sessionId, origin: 'https://notes.example.com', now })
    await consumeTicket(db, { userId, sessionId, token: first.token, origin: 'https://notes.example.com', now: now + 1 })
    const second = await issueTicket(db, { userId, sessionId, origin: 'https://notes.example.com', now: now + 2 })
    const rows = sqlite.prepare('SELECT id FROM webssh_session_tickets').all() as Array<{ id: string }>
    expect(rows).toEqual([{ id: second.id }])
  })
})
