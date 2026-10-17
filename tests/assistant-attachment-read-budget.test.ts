// @vitest-environment node
/**
 * How much of what a turn attached actually reaches the model.
 *
 * A turn's attachment ids are written under a per-message ceiling, but reading them back is a different
 * question: a restored turn can legitimately name more files than one composer box could hold, and a read
 * that stops at eight hands the model a turn with files in it that have no words — while saying nothing
 * about it. So the ceiling that belongs here is the turn's character budget, and what that budget cannot
 * hold has to be counted out loud in the block the model is given.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { MAX_CHAT_ATTACHMENTS } from '../src/shared/assistant'
import type { ChatAttachment } from '../src/shared/assistant'
import { SCHEMA_STATEMENTS } from '../src/worker/db/schema'
import { AssistantStore } from '../src/worker/assistant/store'
import { CHAT_FILE_CHAR_CAP, CHAT_TOTAL_CHAR_CAP } from '../src/worker/assistant/chat-files'
import { ATTACHMENT_MARKER, expandChatAttachments } from '../src/worker/assistant/attachments'
import type { Env } from '../src/worker/env'
import { makeD1 } from './doubles/d1-sqlite'

const USER = '0123456789abcdefghjkmnpqrs'

/** A document whose words were pulled out by the browser at upload time, so no bytes are read here. */
function pdfRow(id: string): ChatAttachment {
  return { id, kind: 'file', filename: `${id}.pdf`, mime: 'application/pdf', size: 1024, key: `chat/files/user/${id}`, createdAt: 1_700_000_000 }
}

/**
 * The store as it answers today.
 *
 * `chatAttachmentTexts` reads every id it is handed, in chunks sized for D1's bind ceiling. It used to cut
 * the list to the per-turn *write* ceiling, which is a different question — a restored turn can name more
 * files than one composer box could hold — and the read then answered with the first eight while the rest
 * reached the model as files with no words and no mention of being missing. The real store is pinned
 * directly below; this double is what lets the budget behaviour be tested without a database.
 */
function storeWithTexts(texts: Record<string, string>): AssistantStore {
  const ids = Object.keys(texts)
  return {
    async chatAttachments() { return ids.map(pdfRow) },
    async chatAttachmentTexts(wanted: readonly string[]): Promise<Map<string, string>> {
      return new Map(wanted.filter((id) => texts[id]).map((id) => [id, texts[id]!]))
    },
  } as unknown as AssistantStore
}

async function blockFor(texts: Record<string, string>): Promise<string> {
  const payload = await expandChatAttachments(storeWithTexts(texts), {} as Env, Object.keys(texts), false)
  return payload.block
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('the attachment text a turn feeds the model', () => {
  it('reads every document the turn names, not only the first eight', async () => {
    const total = MAX_CHAT_ATTACHMENTS + 4
    const texts = Object.fromEntries(
      Array.from({ length: total }, (_, index) => [`att${index}`, `words from document ${index}`]),
    )
    const block = await blockFor(texts)
    expect(countOf(block, '(text read from the file)')).toBe(total)
    for (let index = 0; index < total; index++) expect(block).toContain(`words from document ${index}`)
    expect(block).not.toContain('(not text; contents not read)')
  })

  it('counts out loud the files this turn\'s character budget left out', async () => {
    const huge = 'x'.repeat(CHAT_FILE_CHAR_CAP)
    // Three files of the per-file ceiling each already spend the turn's total budget, so the fourth has
    // text that is not going anywhere — and the model has to be told that, rather than reading a turn
    // whose fourth file is simply quiet.
    const block = await blockFor({ a: huge, b: huge, c: huge, d: huge })
    expect(countOf(block, '(text read from the file)')).toBe(3)
    // The file that got nothing is still named, so the turn does not read as three attachments.
    expect(block).toContain(`${ATTACHMENT_MARKER}: d.pdf`)
    expect(block).toContain('(this turn\'s attachment budget is full; contents not read)')
    expect(block).toContain('1 of the 4')
    expect(block).toContain(`${CHAT_TOTAL_CHAR_CAP}`)
  })

  it('says nothing about a left-out count when the whole turn fits', async () => {
    const block = await blockFor({ a: 'first file', b: 'second file' })
    expect(countOf(block, '(text read from the file)')).toBe(2)
    expect(block).not.toContain('left out')
    expect(block).not.toContain('budget is full')
  })
})

// The double above proves the read path honours what the store returns. This proves the store itself
// returns everything it was asked for — without it, the clamp could come back and the tests above would
// still pass, because they only ever assert what the fixture chose to hand over.
describe('the store reads every attachment id it is asked for', () => {
  it('answers more ids than one turn may write, in chunks', async () => {
    const sqlite = new DatabaseSync(':memory:')
    sqlite.exec(SCHEMA_STATEMENTS.join(';'))
    const store = new AssistantStore(makeD1(sqlite), USER, {} as Env)
    const total = MAX_CHAT_ATTACHMENTS + 4
    for (let index = 0; index < total; index++) {
      await store.createChatAttachment({
        id: `att${index}`, kind: 'file', filename: `doc${index}.pdf`,
        mime: 'application/pdf', size: 16, key: `chat/files/${USER}/att${index}`,
        extractedText: `words from document ${index}`,
      })
    }
    const texts = await store.chatAttachmentTexts(Array.from({ length: total }, (_, index) => `att${index}`))
    expect(texts.size, 'a read must not inherit the per-turn write ceiling').toBe(total)
    expect(texts.get(`att${total - 1}`)).toBe(`words from document ${total - 1}`)
    sqlite.close()
  })
})
