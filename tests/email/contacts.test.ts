// @vitest-environment node
import type { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailContact, EmailGroupWithMembers } from '../../src/shared/email/contacts'
import { listEmailContacts, rememberRecipientAddresses, touchContacts } from '../../src/worker/email/contacts'
import type { AppBindings, Env } from '../../src/worker/env'
import { errorResponse } from '../../src/worker/lib/errors'
import { newId } from '../../src/worker/lib/id'
import { emailContactsRoutes } from '../../src/worker/routes/email-contacts'
import { testBindings } from '../doubles/bindings'
import { seedUser, testDatabase } from '../fixtures/email/harness'

let sqlite: DatabaseSync
let db: D1Database
let env: Env
let userId: string
let userRole: 'owner' | 'member'

function app(): Hono<AppBindings> {
  const instance = new Hono<AppBindings>()
  instance.onError((error, c) => errorResponse(c, error))
  instance.use('/api/email/*', async (c, next) => {
    if (userId) {
      c.set('userId', userId)
      c.set('user', {
        id: userId,
        username: 'owner',
        login: 'owner',
        name: 'Owner',
        avatarUrl: '',
        role: userRole,
        createdAt: 0,
        settingsRaw: '{}',
      })
    }
    await next()
  })
  instance.route('/api/email', emailContactsRoutes)
  return instance
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return await app().request(`/api/email${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env)
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T
}

async function errorOf(response: Response): Promise<{ code: string; message: string }> {
  return (await json<{ error: { code: string; message: string } }>(response)).error
}

async function createContact(input: Record<string, unknown> = {}): Promise<EmailContact> {
  const response = await call('POST', '/contacts', {
    email: 'alice@example.com',
    name: 'Alice',
    ...input,
  })
  expect(response.status).toBe(201)
  return json<EmailContact>(response)
}

async function createGroup(name = 'Team'): Promise<EmailGroupWithMembers> {
  const response = await call('POST', '/groups', { name })
  expect(response.status).toBe(201)
  return json<EmailGroupWithMembers>(response)
}

async function groups(): Promise<EmailGroupWithMembers[]> {
  const response = await call('GET', '/groups')
  expect(response.status).toBe(200)
  return json<EmailGroupWithMembers[]>(response)
}

async function contacts(query = ''): Promise<EmailContact[]> {
  const response = await call('GET', `/contacts${query}`)
  expect(response.status).toBe(200)
  return json<EmailContact[]>(response)
}

function membershipCount(): number {
  return Number((sqlite.prepare(`SELECT COUNT(*) AS n FROM email_group_members`).get() as { n: number }).n)
}

beforeEach(() => {
  const database = testDatabase()
  sqlite = database.sqlite
  db = database.db
  env = testBindings(db)
  userId = newId()
  userRole = 'owner'
  seedUser(sqlite, userId)
})

describe('contact route auth', () => {
  it('rejects anonymous callers and members', async () => {
    userId = ''
    const anonymous = await call('GET', '/contacts')
    expect(anonymous.status).toBe(401)
    expect((await errorOf(anonymous)).code).toBe('unauthenticated')

    userId = newId()
    userRole = 'member'
    const member = await call('GET', '/contacts')
    expect(member.status).toBe(403)
    expect((await errorOf(member)).code).toBe('forbidden')

    const group = await call('POST', '/groups', { name: 'Team' })
    expect(group.status).toBe(403)
  })
})

describe('contact CRUD', () => {
  it('creates, lists, updates and deletes a contact', async () => {
    const created = await createContact({
      email: 'Alice@Example.com',
      name: ' Alice ',
      company: 'Acme',
      notes: 'Met at a conference',
      starred: true,
    })
    expect(created.email).toBe('Alice@Example.com')
    expect(created.name).toBe('Alice')
    expect(created.company).toBe('Acme')
    expect(created.notes).toBe('Met at a conference')
    expect(created.starred).toBe(true)
    expect(created.usageCount).toBe(0)
    expect(created.lastUsedAt).toBeNull()

    const listed = await contacts()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ id: created.id, email: 'Alice@Example.com', starred: true })

    const patched = await call('PATCH', `/contacts/${created.id}`, { name: 'Alicia', starred: false })
    expect(patched.status).toBe(200)
    const updated = await json<EmailContact>(patched)
    expect(updated.name).toBe('Alicia')
    expect(updated.starred).toBe(false)
    expect(updated.company).toBe('Acme')

    const removed = await call('DELETE', `/contacts/${created.id}`)
    expect(removed.status).toBe(204)
    expect(await contacts()).toEqual([])

    const missing = await call('DELETE', `/contacts/${created.id}`)
    expect(missing.status).toBe(404)
    expect((await errorOf(missing)).code).toBe('not_found')
  })

  it('keeps email unique per user, ignoring case', async () => {
    await createContact({ email: 'Alice@Example.com' })
    const duplicate = await call('POST', '/contacts', { email: 'alice@example.com' })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('email_contact_exists')

    const other = newId()
    seedUser(sqlite, other)
    userId = other
    const allowed = await call('POST', '/contacts', { email: 'alice@example.com' })
    expect(allowed.status).toBe(201)
    expect(await contacts()).toHaveLength(1)
  })

  it('rejects a patch that would collide with another contact email', async () => {
    const first = await createContact({ email: 'first@example.com' })
    const second = await createContact({ email: 'second@example.com' })
    const collision = await call('PATCH', `/contacts/${second.id}`, { email: 'FIRST@example.com' })
    expect(collision.status).toBe(409)
    expect((await errorOf(collision)).code).toBe('email_contact_exists')

    const same = await call('PATCH', `/contacts/${first.id}`, { email: 'FIRST@example.com' })
    expect(same.status).toBe(200)
  })

  it('reflects user edits of email and notes', async () => {
    const created = await createContact({ email: 'old@example.com' })
    const patched = await call('PATCH', `/contacts/${created.id}`, {
      email: 'new@example.com',
      notes: 'Updated note',
    })
    expect(patched.status).toBe(200)
    const updated = await json<EmailContact>(patched)
    expect(updated.email).toBe('new@example.com')
    expect(updated.notes).toBe('Updated note')
  })
})

describe('contact isolation', () => {
  it('does not expose one user contacts to another', async () => {
    const created = await createContact({ email: 'private@example.com' })
    const other = newId()
    seedUser(sqlite, other)
    userId = other
    expect(await contacts()).toEqual([])

    const patch = await call('PATCH', `/contacts/${created.id}`, { name: 'Stolen' })
    expect(patch.status).toBe(404)
    expect((await errorOf(patch)).code).toBe('not_found')

    const removed = await call('DELETE', `/contacts/${created.id}`)
    expect(removed.status).toBe(404)
  })
})

describe('group CRUD and membership', () => {
  it('creates groups with case-insensitive unique names per user', async () => {
    const group = await createGroup('Team')
    expect(group).toEqual(expect.objectContaining({ name: 'Team', members: [] }))

    const duplicate = await call('POST', '/groups', { name: 'team' })
    expect(duplicate.status).toBe(409)
    expect((await errorOf(duplicate)).code).toBe('email_group_exists')

    const other = await createGroup('Friends')
    const rename = await call('PATCH', `/groups/${other.id}`, { name: 'TEAM' })
    expect(rename.status).toBe(409)
    expect((await errorOf(rename)).code).toBe('email_group_exists')

    const updated = await call('PATCH', `/groups/${other.id}`, { name: 'Friends & Family', description: 'Close circle' })
    expect(updated.status).toBe(200)
    const patched = await json<EmailGroupWithMembers>(updated)
    expect(patched.name).toBe('Friends & Family')
    expect(patched.description).toBe('Close circle')
  })

  it('allows the same group name for another user', async () => {
    await createGroup('Team')
    const other = newId()
    seedUser(sqlite, other)
    userId = other
    const created = await call('POST', '/groups', { name: 'Team' })
    expect(created.status).toBe(201)
  })

  it('adds, lists and removes members', async () => {
    const contact = await createContact({ email: 'member@example.com' })
    const group = await createGroup()

    const added = await call('POST', `/groups/${group.id}/members`, { contactId: contact.id })
    expect(added.status).toBe(204)
    const again = await call('POST', `/groups/${group.id}/members`, { contactId: contact.id })
    expect(again.status).toBe(204)
    expect(membershipCount()).toBe(1)

    const listed = await groups()
    expect(listed[0]!.members.map((member) => member.id)).toEqual([contact.id])

    const removed = await call('DELETE', `/groups/${group.id}/members/${contact.id}`)
    expect(removed.status).toBe(204)
    expect((await groups())[0]!.members).toEqual([])

    const missing = await call('DELETE', `/groups/${group.id}/members/${contact.id}`)
    expect(missing.status).toBe(404)
  })

  it('refuses members from another user', async () => {
    const contact = await createContact({ email: 'member@example.com' })
    const group = await createGroup()
    const other = newId()
    seedUser(sqlite, other)
    userId = other
    const otherGroup = await createGroup('Other team')

    const stolen = await call('POST', `/groups/${otherGroup.id}/members`, { contactId: contact.id })
    expect(stolen.status).toBe(404)
    expect((await errorOf(stolen)).code).toBe('not_found')
    expect(membershipCount()).toBe(0)

    const hidden = await call('POST', `/groups/${group.id}/members`, { contactId: contact.id })
    expect(hidden.status).toBe(404)
  })

  it('removes a deleted contact from its groups but keeps the group', async () => {
    const contact = await createContact({ email: 'member@example.com' })
    const group = await createGroup()
    await call('POST', `/groups/${group.id}/members`, { contactId: contact.id })
    expect(membershipCount()).toBe(1)

    expect((await call('DELETE', `/contacts/${contact.id}`)).status).toBe(204)
    expect(membershipCount()).toBe(0)
    const listed = await groups()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.members).toEqual([])
  })

  it('deletes a group without deleting its contacts', async () => {
    const contact = await createContact({ email: 'member@example.com' })
    const group = await createGroup()
    await call('POST', `/groups/${group.id}/members`, { contactId: contact.id })

    expect((await call('DELETE', `/groups/${group.id}`)).status).toBe(204)
    expect(await groups()).toEqual([])
    expect((await contacts()).map((entry) => entry.id)).toEqual([contact.id])
    expect(membershipCount()).toBe(0)
  })
})

describe('contact search and ranking', () => {
  it('matches name and email and ranks by usage', async () => {
    const alice = await createContact({ email: 'alice@example.com', name: 'Alice' })
    await createContact({ email: 'bob@example.com', name: 'Bob Stone' })
    await createContact({ email: 'carol@example.com', name: 'Carol' })

    expect((await contacts('?q=ALICE')).map((entry) => entry.id)).toEqual([alice.id])
    expect((await contacts('?q=bob@')).map((entry) => entry.email)).toEqual(['bob@example.com'])
    expect(await contacts('?q=missing')).toEqual([])

    await touchContacts(db, userId, [{ email: alice.email }])
    await touchContacts(db, userId, [{ email: alice.email }])
    const ranked = await contacts()
    expect(ranked[0]!.id).toBe(alice.id)
    expect(ranked[0]!.usageCount).toBe(2)
    expect(ranked[0]!.lastUsedAt).not.toBeNull()

    expect(await contacts('?limit=2')).toHaveLength(2)
  })

  it('treats the query as literal text', async () => {
    await createContact({ email: 'alice@example.com', name: 'Alice' })
    expect(await contacts('?q=%25')).toEqual([])
    expect(await contacts('?q=_')).toEqual([])
  })
})

describe('touchContacts', () => {
  it('parses display names out of outgoing recipient lists', async () => {
    const touched = await rememberRecipientAddresses(db, userId, [
      'Grace Hopper <grace@example.com>, ada@example.com',
      'Alan Turing <ALAN@example.com>',
    ])
    expect(touched).toBe(3)
    const listed = await listEmailContacts(db, userId, { query: '', limit: 20 })
    expect(listed.find((entry) => entry.email.toLowerCase() === 'grace@example.com')?.name).toBe('Grace Hopper')
    expect(listed.find((entry) => entry.email.toLowerCase() === 'alan@example.com')?.name).toBe('Alan Turing')
  })

  it('creates minimal contacts and counts repeated use', async () => {
    const touched = await touchContacts(db, userId, [
      { email: 'New@Example.com', name: 'New Person' },
      { email: 'new@example.com' },
      { email: 'not-an-address' },
    ])
    expect(touched).toBe(1)
    const [created] = await contacts()
    expect(created).toMatchObject({
      email: 'New@Example.com',
      name: 'New Person',
      company: '',
      notes: '',
      starred: false,
      usageCount: 1,
    })
    expect(created!.lastUsedAt).not.toBeNull()

    await touchContacts(db, userId, [{ email: 'NEW@example.com', name: 'Override' }])
    const [after] = await contacts()
    expect(after).toMatchObject({ name: 'New Person', usageCount: 2 })
  })

  it('fills a blank name without overwriting a saved one', async () => {
    await touchContacts(db, userId, [{ email: 'blank@example.com' }])
    await touchContacts(db, userId, [{ email: 'blank@example.com', name: 'From Mail' }])
    expect((await contacts())[0]!.name).toBe('From Mail')

    const saved = await createContact({ email: 'saved@example.com', name: 'Saved Name' })
    await touchContacts(db, userId, [{ email: saved.email, name: 'Different' }])
    const found = (await contacts('?q=saved')).find((entry) => entry.id === saved.id)
    expect(found!.name).toBe('Saved Name')
    expect(found!.usageCount).toBe(1)
  })

  it('is scoped to the user', async () => {
    const other = newId()
    seedUser(sqlite, other)
    await touchContacts(db, other, [{ email: 'shared@example.com' }])
    expect(await contacts()).toEqual([])
  })
})

describe('contact validation', () => {
  it('rejects invalid contacts and groups', async () => {
    const invalidEmail = await call('POST', '/contacts', { email: 'not-an-address' })
    expect(invalidEmail.status).toBe(400)
    expect((await errorOf(invalidEmail)).code).toBe('bad_request')

    const longName = await call('POST', '/contacts', { email: 'a@example.com', name: 'x'.repeat(121) })
    expect(longName.status).toBe(400)

    const longNotes = await call('POST', '/contacts', { email: 'a@example.com', notes: 'x'.repeat(2001) })
    expect(longNotes.status).toBe(400)

    const emptyGroup = await call('POST', '/groups', { name: '   ' })
    expect(emptyGroup.status).toBe(400)

    const longGroup = await call('POST', '/groups', { name: 'x'.repeat(81) })
    expect(longGroup.status).toBe(400)

    const contact = await createContact()
    const emptyPatch = await call('PATCH', `/contacts/${contact.id}`, {})
    expect(emptyPatch.status).toBe(400)

    const badBody = await call('POST', '/contacts', { email: 'a@example.com', starred: 'yes' })
    expect(badBody.status).toBe(400)

    const longQuery = await call('GET', `/contacts?q=${'a'.repeat(121)}`)
    expect(longQuery.status).toBe(400)
  })

  it('rejects unknown ids and member payloads', async () => {
    expect((await call('PATCH', `/contacts/${newId()}`, { name: 'Ghost' })).status).toBe(404)
    expect((await call('DELETE', `/groups/${newId()}`)).status).toBe(404)

    const group = await createGroup()
    const noContact = await call('POST', `/groups/${group.id}/members`, {})
    expect(noContact.status).toBe(400)
    expect((await errorOf(noContact)).code).toBe('bad_request')

    const missingGroup = await call('POST', `/groups/${newId()}/members`, { contactId: newId() })
    expect(missingGroup.status).toBe(404)

    const badContact = await call('POST', `/groups/${group.id}/members`, { contactId: 'not-an-id' })
    expect(badContact.status).toBe(400)
  })
})
