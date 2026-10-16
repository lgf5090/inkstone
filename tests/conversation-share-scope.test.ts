// @vitest-environment node
/**
 * What a share link covers, and how that is written down.
 *
 * A link used to mean one conversation and nothing else, so the row's key was the conversation. It now
 * means one conversation *and* the turns it publishes — the empty scope being the whole thread, which is
 * what every link made before this existed meant. Two things follow from that and are pinned here: the
 * same set of turns has to write down as the same string however it was picked, and a reader who narrows a
 * link must not thereby take down the one they already sent.
 *
 * The canonical form matters more than it looks. It is the row's key, so "these three turns" spelled two
 * ways would be two links to the same content — and the reader would be told they had shared something
 * they had not.
 */
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { ChatShareStore, MAX_SHARED_PICK, messageScope, scopeMessageIds } from '../src/worker/assistant/share'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'

/** Three ids of the shape the app mints, so the format check is exercised rather than bypassed. */
const ID_A = '01jqz0000000000000000000aa'
const ID_B = '01jqz0000000000000000000bb'
const ID_C = '01jqz0000000000000000000cc'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  sqlite.exec(SCHEMA_STATEMENTS.join(';'))
  db = makeD1(sqlite)
})

const link = (over: Partial<Parameters<ChatShareStore['upsertShare']>[0]> = {}) => ({
  conversationId: 'conv-1',
  scope: '',
  passwordHash: null,
  expiresAt: null,
  now: 1_700_000_000_000,
  replacePassword: true,
  replaceExpiry: true,
  rotate: false,
  ...over,
})

describe('the scope a selection writes down', () => {
  it('is the same string for the same turns however they were ticked', () => {
    // The order a reader ticks things in is not information: the transcript has one order and the link
    // shows that one.
    expect(messageScope([ID_B, ID_A])).toBe(messageScope([ID_A, ID_B]))
    expect(messageScope([ID_C, ID_A, ID_B])).toBe(messageScope([ID_A, ID_B, ID_C]))
  })

  it('counts a turn once however many times it was named', () => {
    expect(messageScope([ID_A, ID_A, ID_B])).toBe(messageScope([ID_A, ID_B]))
  })

  it('drops what is not an id rather than carrying it into a key', () => {
    // The scope is joined into a query, so anything that is not an id is refused here rather than escaped
    // later. A reader never types one of these; a hand-made request might.
    expect(messageScope([ID_A, '', 'not-an-id', "1' OR 1=1 --"])).toBe(ID_A)
  })

  it('reads back as the turns it names', () => {
    expect(scopeMessageIds(messageScope([ID_A, ID_B]))).toEqual([ID_A, ID_B])
    expect(scopeMessageIds('')).toEqual([])
  })

  it('leaves out an unreadable entry when reading back, too', () => {
    expect(scopeMessageIds(`${ID_A},oops`)).toEqual([ID_A])
  })

  it('stops at the number of turns one link may carry', () => {
    // Bounded because the ids are the key and the filter: a link naming thousands would be a query nobody
    // meant to run, and no reader picks that many exchanges by hand.
    const many = Array.from({ length: MAX_SHARED_PICK + 10 }, (_, index) => `01jqz000000000000000000${String(index).padStart(3, '0')}`)
    expect(scopeMessageIds(messageScope(many))).toHaveLength(MAX_SHARED_PICK)
  })
})

describe('one thread, more than one link', () => {
  it('keeps the whole-thread link and a narrowed one as two rows', async () => {
    const store = new ChatShareStore(db, USER)
    await store.upsertShare(link())
    await store.upsertShare(link({ scope: messageScope([ID_A, ID_B]) }))

    const whole = await store.shareFor('conv-1')
    const narrowed = await store.shareFor('conv-1', messageScope([ID_A, ID_B]))
    expect(whole?.scope).toBe('')
    expect(narrowed?.scope).toBe(messageScope([ID_A, ID_B]))
    // Two addresses, because they are two different publications: narrowing must not rewrite the link
    // the reader already sent somebody.
    expect(narrowed?.slug).not.toBe(whole?.slug)
  })

  it('refreshes the link it already has for that scope rather than minting a second', async () => {
    const store = new ChatShareStore(db, USER)
    await store.upsertShare(link({ scope: messageScope([ID_A]) }))
    const first = await store.shareFor('conv-1', messageScope([ID_A]))
    await store.upsertShare(link({ scope: messageScope([ID_A]), passwordHash: 'hash' }))
    const second = await store.shareFor('conv-1', messageScope([ID_A]))
    // The address is what the reader already handed out, so re-sharing keeps it unless they ask to rotate.
    expect(second?.slug).toBe(first?.slug)
    expect(second?.password_hash).toBe('hash')
    const { results } = await db.prepare(`SELECT slug FROM chat_share_links WHERE user_id = ?1`).bind(USER).all()
    expect(results).toHaveLength(1)
  })

  it('takes down only the link it names', async () => {
    const store = new ChatShareStore(db, USER)
    await store.upsertShare(link())
    await store.upsertShare(link({ scope: messageScope([ID_A]) }))
    await store.deleteShare('conv-1', messageScope([ID_A]))
    expect(await store.shareFor('conv-1', messageScope([ID_A]))).toBeNull()
    // The thread's own link is somebody else's copy of a link, and revoking a narrow one is not a way to
    // un-share the whole conversation.
    expect(await store.shareFor('conv-1')).not.toBeNull()
  })

  it('answers which of the picked turns are really in the conversation', async () => {
    const store = new ChatShareStore(db, USER)
    await db.prepare(
      `INSERT INTO chat_conversations (user_id, id, title, created_at, updated_at) VALUES (?1, ?2, 'Planning', 1, 1)`,
    ).bind(USER, 'conv-1').run()
    for (const id of [ID_A, ID_B]) {
      await db.prepare(
        `INSERT INTO chat_messages (user_id, id, conversation_id, role, content, created_at) VALUES (?1, ?2, 'conv-1', 'user', 'x', 1)`,
      ).bind(USER, id).run()
    }
    // The ones that are here, and only those: an id from another thread is the mistake worth catching
    // before it becomes a key.
    expect((await store.messagesInConversation('conv-1', [ID_A, ID_C])).sort()).toEqual([ID_A])
    expect(await store.messagesInConversation('conv-1', [ID_A, ID_B])).toHaveLength(2)
    expect(await store.messagesInConversation('conv-1', [])).toEqual([])
  })
})
